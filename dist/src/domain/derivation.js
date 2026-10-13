// 运行相位（A1）的类型、取值与优先级统一定义在 derived-status.ts（类型移出以解环，避免双处维护）。
/** 键入型 UI 提示（相位拆分，BOARD.md A1）：用户需键入内容而非选择/确认。
 *  custom 归此类：pi 把 custom 组件定义为接管渲染与键鼠输入的重量级交互，操作负担与键入型一致。 */
const INPUT_PROMPT_KINDS = new Set(['input', 'editor', 'custom']);
const DEFAULT_WINDOW_MS = 5 * 60_000;
const DEFAULT_STUCK_STREAMING_MS = 120_000;
const DEFAULT_STUCK_BUSY_MS = 300_000;
/** 相位扫描的最大回看条目数（session_start 缺失时的保守上界，防上一会话残留标记）。 */
const PHASE_SCAN_FALLBACK_ENTRIES = 500;
function asObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
function numberField(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
/** 历史中属于"当前会话"的起始下标：最近一次 session_start 之后；缺失则保守取最近 N 条。 */
function aliveStart(history) {
    for (let i = history.length - 1; i >= 0; i -= 1) {
        const entry = history[i];
        if (entry !== undefined && entry.kind === 'report' && entry.state === 'session_start') {
            return i + 1;
        }
    }
    return Math.max(0, history.length - PHASE_SCAN_FALLBACK_ENTRIES);
}
/** 前向扫描当前会话窗口，统计未闭合的开启标记（A1）。 */
function scanOpenMarkers(history, from) {
    const markers = {
        uiOpen: false,
        uiOpenSince: null,
        uiOpenKind: null,
        toolOpen: 0,
        compactOpen: false,
        streamingOpen: false,
    };
    const openTools = new Set();
    for (let i = from; i < history.length; i += 1) {
        const entry = history[i];
        if (entry === undefined || entry.kind !== 'report') {
            continue;
        }
        const payload = asObject(entry.payload);
        switch (entry.state) {
            case 'ui_prompt_start':
                markers.uiOpen = true;
                markers.uiOpenSince = entry.timestamp;
                markers.uiOpenKind = typeof payload?.['kind'] === 'string' ? payload['kind'] : null;
                break;
            case 'ui_prompt_end':
                markers.uiOpen = false;
                markers.uiOpenSince = null;
                markers.uiOpenKind = null;
                break;
            case 'session_before_compact':
                markers.compactOpen = true;
                break;
            case 'session_compact':
            case 'session_compact_failed':
                markers.compactOpen = false;
                break;
            case 'message_start':
                if (payload?.['role'] === 'assistant') {
                    markers.streamingOpen = true;
                }
                break;
            case 'message_end':
                if (payload?.['role'] === 'assistant') {
                    markers.streamingOpen = false;
                }
                break;
            case 'tool_execution_start': {
                const id = payload?.['toolCallId'];
                if (typeof id === 'string') {
                    openTools.add(id);
                }
                break;
            }
            case 'tool_execution_end': {
                const id = payload?.['toolCallId'];
                if (typeof id === 'string') {
                    openTools.delete(id);
                }
                break;
            }
        }
    }
    markers.toolOpen = openTools.size;
    return markers;
}
/** 扫描最近 windowMs 的上报，统计错误率、压缩频率与 provider 状态分类（A2）。 */
function scanWindow(history, windowStart) {
    const signals = {
        toolErrors: 0,
        toolAttempts: 0,
        compactions: 0,
        providerClasses: {},
        messageStopReasons: new Set(),
    };
    for (let i = history.length - 1; i >= 0; i -= 1) {
        const entry = history[i];
        if (entry === undefined) {
            continue;
        }
        // history 按到达顺序追加，时间戳大体单调；早于窗口即可停止回看。
        if (entry.timestamp < windowStart) {
            break;
        }
        if (entry.kind !== 'report') {
            continue;
        }
        const payload = asObject(entry.payload);
        switch (entry.state) {
            case 'tool_execution_end':
                signals.toolAttempts += 1;
                if (payload?.['isError'] === true) {
                    signals.toolErrors += 1;
                }
                break;
            case 'session_compact':
            case 'session_compact_failed':
                signals.compactions += 1;
                break;
            case 'after_provider_response': {
                const status = numberField(payload?.['status']);
                if (status !== undefined && status >= 400) {
                    const cls = status === 429
                        ? 'throttled'
                        : status === 401 || status === 403
                            ? 'auth'
                            : status >= 500
                                ? 'server'
                                : 'client';
                    signals.providerClasses[cls] = (signals.providerClasses[cls] ?? 0) + 1;
                }
                break;
            }
            case 'message_end': {
                const reason = payload?.['stopReason'];
                if (reason === 'error' || reason === 'aborted') {
                    signals.messageStopReasons.add(reason);
                }
                break;
            }
        }
    }
    return signals;
}
/** 运行相位（A1）。 */
function derivePhase(online, snapshot, markers) {
    if (!online) {
        return 'offline';
    }
    if (markers.uiOpen) {
        // kind 缺失或未知 → 保守归 waiting-human（与拆分前行为一致）。
        return markers.uiOpenKind !== null && INPUT_PROMPT_KINDS.has(markers.uiOpenKind)
            ? 'awaiting-input'
            : 'waiting-human';
    }
    if (markers.toolOpen > 0) {
        return 'tool';
    }
    if (markers.compactOpen) {
        return 'compacting';
    }
    if (markers.streamingOpen) {
        return 'streaming';
    }
    // 无待闭合标记：快照显式声明非空闲 → 活动（如 run 内的事件间隙）。
    return snapshot?.['isIdle'] === false ? 'active' : 'idle';
}
/** 注意队列（A2），按 error 优先排序。 */
function deriveAttention(history, options, phase, snapshot, markers) {
    const items = [];
    const window = scanWindow(history, options.now - options.windowMs);
    // aliveStart 在循环条件中重复求值会是热路径上的 O(N²)（P1 修复）：提升到函数入口。
    const aliveIndex = aliveStart(history);
    // 阻塞等待人工（BOARD.md A2 首位注意信号；severity 为 warn，健康度对应 ◐）。
    // 等待输入/等待人工两相位都阻塞在用户响应上：共用同一信号与排队，detail 的 kind 区分形态。
    if ((phase === 'waiting-human' || phase === 'awaiting-input') && markers.uiOpenSince !== null) {
        const secs = Math.max(0, Math.round((options.now - markers.uiOpenSince) / 1000));
        items.push({
            severity: 'warn',
            signal: 'waiting-human',
            detail: `等待人工输入（${markers.uiOpenKind ?? 'ui 提示'}，已 ${secs}s）`,
        });
    }
    if (!options.online) {
        // 离线且当前会话（最近 session_start 之后）无 session_shutdown：疑似崩溃。
        const hasShutdown = history
            .slice(aliveIndex)
            .some((entry) => entry.kind === 'report' && entry.state === 'session_shutdown');
        if (!hasShutdown && history.length > 0) {
            items.push({
                severity: 'error',
                signal: 'offline-unexpected',
                detail: '离线且无 session_shutdown 记录（疑似进程异常退出）',
            });
        }
    }
    // run 级结局：从最近处回看，先遇 before_agent_start 表示新 run 进行中（无已结算结局），
    // 与 A4 的 run 切片边界对齐。
    for (let i = history.length - 1; i >= aliveIndex; i -= 1) {
        const entry = history[i];
        if (entry === undefined || entry.kind !== 'report') {
            continue;
        }
        if (entry.state === 'before_agent_start') {
            break;
        }
        if (entry.state === 'agent_before_settle') {
            const outcome = asObject(entry.payload)?.['outcome'];
            if (outcome === 'error') {
                items.push({ severity: 'error', signal: 'run-error', detail: '最近 run 以 error 结束' });
            }
            else if (outcome === 'aborted') {
                items.push({
                    severity: 'warn',
                    signal: 'run-aborted',
                    detail: '最近 run 被中止（aborted）',
                });
            }
            break;
        }
    }
    if (window.messageStopReasons.has('error')) {
        items.push({
            severity: 'error',
            signal: 'message-error',
            detail: '消息以 error 停止（见 message_end.stopReason）',
        });
    }
    if (window.messageStopReasons.has('aborted')) {
        items.push({
            severity: 'warn',
            signal: 'message-aborted',
            detail: '消息以 aborted 停止（可能为用户中断）',
        });
    }
    // provider 状态分类（附次数）。
    const providerDetails = {
        throttled: 'provider 限流（429）',
        auth: 'provider 鉴权失败（401/403）',
        server: 'provider 服务端错误（5xx）',
        client: 'provider 请求被拒（4xx）',
    };
    for (const [cls, count] of Object.entries(window.providerClasses)) {
        items.push({
            severity: cls === 'throttled' || cls === 'client' ? 'warn' : 'error',
            signal: `provider-${cls}`,
            detail: `${providerDetails[cls] ?? 'provider 错误'} ×${count}（最近窗口）`,
        });
    }
    // 压缩失败与压缩频率（上下文压力）：看最近一次压缩事件的结局，成功即解除；
    // 扫描限在当前会话窗口内（避免陈旧信号跨会话残留）。
    let lastCompactFailed = false;
    for (let i = history.length - 1; i >= aliveIndex; i -= 1) {
        const entry = history[i];
        if (entry === undefined || entry.kind !== 'report') {
            continue;
        }
        if (entry.state === 'session_compact') {
            lastCompactFailed = false;
            break;
        }
        if (entry.state === 'session_compact_failed') {
            lastCompactFailed = asObject(entry.payload)?.['aborted'] !== true;
            break;
        }
    }
    if (lastCompactFailed) {
        items.push({
            severity: 'error',
            signal: 'compact-failed',
            detail: '上下文压缩失败（上下文压力未释放）',
        });
    }
    if (window.compactions >= 3) {
        items.push({
            severity: 'warn',
            signal: 'compact-frequent',
            detail: `最近窗口压缩 ${window.compactions} 次（上下文压力）`,
        });
    }
    // 工具错误率（≥2 次失败且超 30% 才上榜，避免单次失败噪声）。
    if (window.toolAttempts > 0) {
        const rate = window.toolErrors / window.toolAttempts;
        if (window.toolErrors >= 2 && rate > 0.3) {
            items.push({
                severity: 'warn',
                signal: 'tool-error-rate',
                detail: `工具错误率 ${(rate * 100).toFixed(0)}%（${window.toolErrors}/${window.toolAttempts}，最近窗口）`,
            });
        }
    }
    // 上下文占用（快照）。
    const percent = numberField(asObject(snapshot?.['contextUsage'])?.['percent']);
    if (percent !== undefined && percent > 85) {
        items.push({
            severity: 'warn',
            signal: 'context-pressure',
            detail: `上下文占用 ${percent.toFixed(0)}%`,
        });
    }
    // 传输链路丢弃（B5）：上报本身丢包时，"运行良好"的结论不可信。
    const transport = asObject(snapshot?.['transport']);
    const dropped = numberField(transport?.['dropped']);
    if (dropped !== undefined && dropped > 0) {
        items.push({
            severity: 'warn',
            signal: 'transport-drop',
            detail: `传输链路累计丢弃 ${dropped} 条上报（展板数据可能不完整）`,
        });
    }
    // 疑似卡死：相位表明在工作，但窗口内无任何上报进展。
    const lastEntry = history[history.length - 1];
    if (lastEntry !== undefined) {
        const age = options.now - lastEntry.timestamp;
        const threshold = phase === 'streaming' ? options.stuckStreamingMs : options.stuckBusyMs;
        if ((phase === 'streaming' || phase === 'tool' || phase === 'compacting' || phase === 'active') &&
            age > threshold) {
            items.push({
                severity: 'warn',
                signal: 'stuck',
                detail: `相位为${phase}但已 ${Math.round(age / 1000)}s 无任何上报进展`,
            });
        }
    }
    return items.sort((a, b) => itemQueueRank(a) - itemQueueRank(b));
}
/** 注意项排队序：等待人工（最直接的行动项）→ error → 其余 warn。 */
function itemQueueRank(item) {
    if (item.signal === 'waiting-human') {
        return 0;
    }
    return item.severity === 'error' ? 1 : 2;
}
/** 最近一次 run 摘要（A4）：从最近一次 before_agent_start 切分。 */
function deriveRun(history, now) {
    const from = aliveStart(history);
    let runStart = -1;
    for (let i = history.length - 1; i >= from; i -= 1) {
        const entry = history[i];
        if (entry !== undefined && entry.kind === 'report' && entry.state === 'before_agent_start') {
            runStart = i;
            break;
        }
    }
    const empty = {
        running: false,
        startedAt: null,
        endedAt: null,
        durationMs: null,
        outcome: null,
        turns: 0,
        toolCalls: 0,
        totalTokens: 0,
    };
    if (runStart === -1) {
        return empty;
    }
    let outcome = null;
    let endedAt = null;
    let turns = 0;
    let toolCalls = 0;
    let totalTokens = 0;
    for (let i = runStart; i < history.length; i += 1) {
        const entry = history[i];
        if (entry === undefined || entry.kind !== 'report') {
            continue;
        }
        const payload = asObject(entry.payload);
        switch (entry.state) {
            case 'turn_start':
                turns += 1;
                break;
            case 'tool_execution_start':
                toolCalls += 1;
                break;
            case 'tool_execution_end': {
                // 工具自身用量（含嵌套调用累计）计入 run 总量（BOARD.md A4）。
                const toolTokens = numberField(payload?.['usageTotalTokens']);
                if (toolTokens !== undefined) {
                    totalTokens += toolTokens;
                }
                break;
            }
            case 'message_end': {
                const usage = asObject(payload?.['usage']);
                const tokens = numberField(usage?.['totalTokens']);
                if (tokens !== undefined) {
                    totalTokens += tokens;
                }
                break;
            }
            case 'agent_before_settle': {
                const raw = payload?.['outcome'];
                outcome = raw === 'error' || raw === 'aborted' || raw === 'completed' ? raw : null;
                endedAt = entry.timestamp;
                break;
            }
            case 'agent_end':
            case 'agent_settled':
                endedAt = entry.timestamp;
                break;
        }
    }
    const startedAt = history[runStart]?.timestamp ?? null;
    const running = endedAt === null;
    const durationMs = startedAt === null ? null : (endedAt ?? now) - startedAt;
    return { running, startedAt, endedAt, durationMs, outcome, turns, toolCalls, totalTokens };
}
/**
 * 从注册记录派生展板状态（A1-A4 的单一入口）。
 *
 * @param record agent 注册记录（history 为到达顺序追加、环形截断）
 * @param options now 为 server 时钟；online 为 REQ-013 的派生在线态
 */
export function deriveAgentStatus(record, options) {
    const resolved = {
        now: options.now,
        online: options.online,
        windowMs: options.windowMs ?? DEFAULT_WINDOW_MS,
        stuckStreamingMs: options.stuckStreamingMs ?? DEFAULT_STUCK_STREAMING_MS,
        stuckBusyMs: options.stuckBusyMs ?? DEFAULT_STUCK_BUSY_MS,
    };
    const snapshot = asObject(record.latest['agent_snapshot']?.payload);
    const markers = scanOpenMarkers(record.history, aliveStart(record.history));
    const phase = derivePhase(resolved.online, snapshot, markers);
    const attention = deriveAttention(record.history, resolved, phase, snapshot, markers);
    const hasError = attention.some((item) => item.severity === 'error');
    const level = !resolved.online && !hasError
        ? 'unknown'
        : hasError
            ? 'attention'
            : attention.length > 0
                ? 'watch'
                : 'good';
    return {
        phase,
        health: { level, attention },
        run: deriveRun(record.history, resolved.now),
    };
}
//# sourceMappingURL=derivation.js.map
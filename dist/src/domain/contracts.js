/**
 * 状态注册表与逐状态契约（schema）：client-server 协议的唯一信源。
 *
 * 职责契约：
 * - 状态清单与《pi 扩展手册》一一对应：41 个 ExtensionAPI.on() 可订阅事件 + 1 个
 *   周期采样的 agent_snapshot（ExtensionContext 可采样字段全集）。共 42 项（STATE_REGISTRY）。
 * - 每个状态拥有独立契约与 semver 版本；新增状态=向注册表追加条目，既有结构不变（加法式演进）。
 * - 本层无外部依赖；契约以可读数据结构声明，由 validation.ts 校验。
 * 设计文档：docs/DESIGN.md §2/§3。
 */
// ---------------------------------------------------------------------------
// 信封与协议常量
// ---------------------------------------------------------------------------
/** 当前信封协议版本（大版本）。不兼容变更才递增。 */
export const PROTOCOL_VERSION = '1';
/** server 支持的信封协议版本集合。 */
export const SUPPORTED_PROTOCOL_VERSIONS = [PROTOCOL_VERSION];
// ---------------------------------------------------------------------------
// 字段构造助手（保持契约表紧凑）
// ---------------------------------------------------------------------------
const str = (name, required = false, extra = {}) => ({
    name,
    type: 'string',
    required,
    ...extra,
});
const int = (name, required = false, min = 0, max) => ({
    name,
    type: 'integer',
    required,
    min,
    ...(max === undefined ? {} : { max }),
});
const num = (name, required = false, min = 0, max, extra = {}) => ({
    name,
    type: 'number',
    required,
    min,
    ...(max === undefined ? {} : { max }),
    ...extra,
});
const bool = (name, required = false) => ({
    name,
    type: 'boolean',
    required,
});
const obj = (name, fields, required = false) => ({
    name,
    type: 'object',
    required,
    fields,
});
const arr = (name, items, required = false, extra = {}) => ({ name, type: 'array', required, items, ...extra });
/** provider/model 复合标识格式。 */
const PROVIDER_MODEL_PATTERN = '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$';
/** 共享：消息角色计数对象（context / context_with_system / agent_end）。 */
const roleCountsField = obj('roleCounts', [int('system'), int('user'), int('assistant'), int('toolResult')], true);
/** 共享：provider header 名称数组（仅键名，不含值——隐私设计 docs/DESIGN.md §9）。 */
const headerNamesField = arr('headerNames', str('header', false, { min: 1, max: 128 }), true, {
    max: 128,
});
/** 共享：工具调用标识三字段。 */
const toolCallIdFields = [
    str('toolCallId', true, { min: 1, max: 128 }),
    str('toolName', true, { min: 1, max: 128 }),
    str('parentToolCallId', false, { min: 1, max: 128 }),
];
const payload = (fields) => ({
    name: 'payload',
    type: 'object',
    required: true,
    fields,
});
// ---------------------------------------------------------------------------
// 状态注册表（42 项）
// ---------------------------------------------------------------------------
const CONTRACTS = [
    // --- 资源发现与会话生命周期 ----------------------------------------------
    {
        state: 'project_trust',
        version: '1.0.0',
        trigger: '项目信任决策前（仅个人/显式扩展参与）',
        frequency: 'event',
        description: '项目信任事件：携带工作目录。',
        payload: payload([str('cwd', true, { min: 1, max: 4096 })]),
    },
    {
        state: 'resources_discover',
        version: '1.0.0',
        trigger: 'session_start 后允许扩展补充资源路径',
        frequency: 'event',
        description: '资源发现事件：触发原因与工作目录。',
        payload: payload([
            str('cwd', true, { min: 1, max: 4096 }),
            str('reason', true, { enum: ['startup', 'reload'] }),
        ]),
    },
    {
        state: 'mcp_servers_change',
        version: '1.0.0',
        trigger: '扩展注册或注销 MCP server',
        frequency: 'event',
        description: 'MCP server 注册变更：数量与名称列表。',
        payload: payload([
            int('serverCount', true, 0),
            arr('serverNames', str('serverName', false, { min: 1, max: 128 }), true, { max: 256 }),
        ]),
    },
    {
        state: 'session_start',
        version: '1.0.0',
        trigger: '会话启动/加载/重载/new/resume/fork',
        frequency: 'event',
        description: '会话开始事件：原因与上一会话文件。',
        payload: payload([
            str('reason', true, { enum: ['startup', 'reload', 'new', 'resume', 'fork'] }),
            str('previousSessionFile', false, { min: 1, max: 4096 }),
        ]),
    },
    {
        state: 'session_info_changed',
        version: '1.0.0',
        trigger: '会话元数据（名称）变化',
        frequency: 'event',
        description: '会话名称变化：空串表示清除。',
        payload: payload([str('name', false, { min: 0, max: 256 })]),
    },
    {
        state: 'session_before_switch',
        version: '1.0.0',
        trigger: '切换到另一会话前（可取消）',
        frequency: 'event',
        description: '会话切换前事件。',
        payload: payload([
            str('reason', true, { enum: ['new', 'resume'] }),
            str('targetSessionFile', false, { min: 1, max: 4096 }),
        ]),
    },
    {
        state: 'session_before_fork',
        version: '1.0.0',
        trigger: '分叉会话前（可取消）',
        frequency: 'event',
        description: '会话分叉前事件：分叉点与位置。',
        payload: payload([
            str('entryId', true, { min: 1, max: 128 }),
            str('position', true, { enum: ['before', 'at'] }),
        ]),
    },
    {
        state: 'session_before_compact',
        version: '1.0.0',
        trigger: '上下文压缩前（可取消或定制）',
        frequency: 'event',
        description: '压缩前事件：触发原因、是否重试、分支条目数。',
        payload: payload([
            str('reason', true, { enum: ['manual', 'threshold', 'overflow'] }),
            bool('willRetry', true),
            int('branchEntryCount', true, 0),
        ]),
    },
    {
        state: 'session_compact',
        version: '1.0.0',
        trigger: '上下文压缩成功后',
        frequency: 'event',
        description: '压缩成功事件。',
        payload: payload([
            str('reason', true, { enum: ['manual', 'threshold', 'overflow'] }),
            bool('willRetry', true),
        ]),
    },
    {
        state: 'session_compact_failed',
        version: '1.0.0',
        trigger: '压缩失败或中止后',
        frequency: 'event',
        description: '压缩失败事件：原因、中止标志、错误消息。',
        payload: payload([
            str('reason', true, { enum: ['manual', 'threshold', 'overflow'] }),
            bool('aborted', true),
            bool('willRetry', true),
            str('errorMessage', false, { max: 1024 }),
        ]),
    },
    {
        state: 'session_shutdown',
        version: '1.0.0',
        trigger: '扩展运行时因退出/重载/会话替换而卸载前',
        frequency: 'event',
        description: '会话关闭事件：原因与目标会话文件。',
        payload: payload([
            str('reason', true, { enum: ['quit', 'reload', 'new', 'resume', 'fork'] }),
            str('targetSessionFile', false, { min: 1, max: 4096 }),
        ]),
    },
    {
        state: 'session_before_tree',
        version: '1.0.0',
        trigger: '会话树导航前（可取消）',
        frequency: 'event',
        description: '树导航前事件：目标条目与旧叶。',
        payload: payload([
            str('targetId', true, { min: 1, max: 128 }),
            str('oldLeafId', false, { min: 0, max: 128 }),
            bool('userWantsSummary', true),
        ]),
    },
    {
        state: 'session_tree',
        version: '1.0.0',
        trigger: '会话树导航后',
        frequency: 'event',
        description: '树导航完成事件：新旧叶与摘要来源。',
        payload: payload([
            str('newLeafId', false, { min: 0, max: 128 }),
            str('oldLeafId', false, { min: 0, max: 128 }),
            bool('fromExtension', false),
        ]),
    },
    // --- 上下文与 provider 交互（高频，coalesce） -----------------------------
    {
        state: 'context',
        version: '1.0.0',
        trigger: '每次 LLM 调用前（不含系统消息的对话）',
        frequency: 'event+coalesce',
        coalesceWindowMs: 1000,
        description: '上下文事件：消息数与角色计数。',
        payload: payload([int('messageCount', true, 0), roleCountsField]),
    },
    {
        state: 'context_with_system',
        version: '1.0.0',
        trigger: '每次 LLM 调用前（含系统消息的完整转录）',
        frequency: 'event+coalesce',
        coalesceWindowMs: 1000,
        description: '完整上下文事件（含系统消息）。',
        payload: payload([int('messageCount', true, 0), roleCountsField]),
    },
    {
        state: 'cache_warming_decision',
        version: '1.0.0',
        trigger: 'prompt 缓存预热决策评估时',
        frequency: 'event',
        description: '缓存预热决策：动作与成本估计。',
        payload: payload([
            str('action', false, { enum: ['warm', 'stop'] }),
            num('warmCost', false),
            num('missCost', false),
            num('continuationProbability', false, 0, 1),
        ]),
    },
    {
        state: 'before_provider_request',
        version: '1.0.0',
        trigger: 'provider 请求发送前',
        frequency: 'event+coalesce',
        coalesceWindowMs: 1000,
        description: 'provider 请求前出现性事件（载荷为空对象）。',
        payload: payload([]),
    },
    {
        state: 'before_provider_headers',
        version: '1.0.0',
        trigger: '请求头组装后、provider HTTP 调用前',
        frequency: 'event',
        description: '请求头事件：仅 header 名称（值不上报）。',
        payload: payload([headerNamesField]),
    },
    {
        state: 'after_provider_response',
        version: '1.0.0',
        trigger: 'provider 响应接收后、流消费前',
        frequency: 'event',
        description: '响应事件：HTTP 状态与 header 名称。',
        payload: payload([int('status', true, 100, 599), headerNamesField]),
    },
    {
        state: 'provider_stream_event',
        version: '1.0.0',
        trigger: '每个解析后的 provider 流事件（归一化前）',
        frequency: 'event+coalesce',
        coalesceWindowMs: 1000,
        description: 'provider 流事件：provider/api/model/事件类型。',
        payload: payload([
            str('provider', true, { min: 1, max: 64 }),
            str('api', true, { min: 1, max: 64 }),
            str('model', true, { min: 1, max: 128 }),
            str('eventType', false, { min: 1, max: 64 }),
        ]),
    },
    // --- agent 运行循环 --------------------------------------------------------
    {
        state: 'before_agent_start',
        version: '1.1.0',
        trigger: '用户提交 prompt 后、agent 循环前',
        frequency: 'event',
        description: 'agent 循环前事件：提示词长度、图片数、系统提示长度与触发来源。',
        payload: payload([
            int('promptLength', true, 0),
            int('imageCount', true, 0),
            int('systemPromptLength', true, 0),
            str('messageType', false, { enum: ['user', 'custom'] }),
        ]),
    },
    {
        state: 'agent_start',
        version: '1.0.0',
        trigger: 'agent 循环开始',
        frequency: 'event',
        description: 'agent 循环开始事件（出现性）。',
        payload: payload([]),
    },
    {
        state: 'agent_end',
        version: '1.0.0',
        trigger: 'agent 循环结束',
        frequency: 'event',
        description: 'agent 循环结束事件：消息数与角色计数。',
        payload: payload([int('messageCount', true, 0), roleCountsField]),
    },
    {
        state: 'agent_before_settle',
        version: '1.0.0',
        trigger: '最终收尾前（可追加条目并请求一次续跑）',
        frequency: 'event',
        description: '收尾前事件：结果、条目数、是否续跑。',
        payload: payload([
            str('outcome', true, { enum: ['completed', 'aborted', 'error'] }),
            int('entryCount', true, 0),
            bool('willContinue', true),
        ]),
    },
    {
        state: 'agent_settled',
        version: '1.0.0',
        trigger: 'agent run 完全定居，无自动重试/压缩/续跑',
        frequency: 'event',
        description: '定居事件（出现性）。',
        payload: payload([]),
    },
    // --- UI 与 turn / 消息流 ---------------------------------------------------
    {
        state: 'ui_prompt_start',
        version: '1.0.0',
        trigger: '开始等待阻塞式用户可见扩展 UI 提问',
        frequency: 'event',
        description: 'UI 提问开始：类型与标题。',
        payload: payload([
            str('kind', true, { enum: ['select', 'confirm', 'input', 'editor', 'custom'] }),
            str('title', false, { min: 0, max: 256 }),
        ]),
    },
    {
        state: 'ui_prompt_end',
        version: '1.0.0',
        trigger: '不再等待阻塞式扩展 UI 提问',
        frequency: 'event',
        description: 'UI 提问结束：类型与标题。',
        payload: payload([
            str('kind', true, { enum: ['select', 'confirm', 'input', 'editor', 'custom'] }),
            str('title', false, { min: 0, max: 256 }),
        ]),
    },
    {
        state: 'turn_start',
        version: '1.0.0',
        trigger: '每个 turn 开始',
        frequency: 'event',
        description: 'turn 开始：索引与事件时间戳。',
        payload: payload([int('turnIndex', true, 0), int('eventTimestamp', true, 0)]),
    },
    {
        state: 'turn_end',
        version: '1.0.0',
        trigger: '每个 turn 结束（可续跑）',
        frequency: 'event',
        description: 'turn 结束：索引、工具结果数、消息角色、是否续跑。',
        payload: payload([
            int('turnIndex', true, 0),
            int('toolResultCount', true, 0),
            str('messageRole', true, { enum: ['user', 'assistant', 'toolResult'] }),
            bool('willContinue', true),
        ]),
    },
    {
        state: 'message_start',
        version: '1.0.0',
        trigger: '消息开始（user/assistant/toolResult）',
        frequency: 'event',
        description: '消息开始：角色、内容分片数、模型信息。',
        payload: payload([
            str('role', true, { enum: ['user', 'assistant', 'toolResult'] }),
            int('contentPartCount', true, 0),
            str('provider', false, { min: 1, max: 64 }),
            str('model', false, { min: 1, max: 128 }),
        ]),
    },
    {
        state: 'message_update',
        version: '1.0.0',
        trigger: 'assistant 消息流式逐 token 更新（高频）',
        frequency: 'event+coalesce',
        coalesceWindowMs: 1000,
        description: '消息流式更新：角色、分片数、流事件类型。',
        payload: payload([
            str('role', true, { enum: ['user', 'assistant', 'toolResult'] }),
            int('contentPartCount', true, 0),
            str('eventType', false, { min: 1, max: 64 }),
        ]),
    },
    {
        state: 'message_end',
        version: '1.1.0',
        trigger: '消息结束（可替换最终消息）',
        frequency: 'event',
        description: '消息结束：角色、分片数、模型、实际响应模型、停止原因与用量（含费用）。',
        payload: payload([
            str('role', true, { enum: ['user', 'assistant', 'toolResult'] }),
            int('contentPartCount', true, 0),
            str('provider', false, { min: 1, max: 64 }),
            str('model', false, { min: 1, max: 128 }),
            str('responseModel', false, { min: 1, max: 128 }),
            str('stopReason', false, { min: 1, max: 64 }),
            obj('usage', [
                int('input', false, 0),
                int('output', false, 0),
                int('cacheRead', false, 0),
                int('cacheWrite', false, 0),
                int('totalTokens', false, 0),
                obj('cost', [
                    num('input', false, 0),
                    num('output', false, 0),
                    num('cacheRead', false, 0),
                    num('cacheWrite', false, 0),
                    num('total', false, 0),
                ], false),
            ], false),
        ]),
    },
    {
        state: 'tool_execution_start',
        version: '1.0.0',
        trigger: '工具开始执行',
        frequency: 'event',
        description: '工具执行开始：调用标识与参数键名。',
        payload: payload([
            ...toolCallIdFields,
            arr('argKeys', str('argKey', false, { min: 1, max: 64 }), true, { max: 64 }),
        ]),
    },
    {
        state: 'tool_execution_update',
        version: '1.0.0',
        trigger: '工具执行部分/流式输出（高频）',
        frequency: 'event+coalesce',
        coalesceWindowMs: 1000,
        description: '工具执行更新：调用标识与是否有部分结果。',
        payload: payload([
            str('toolCallId', true, { min: 1, max: 128 }),
            str('toolName', true, { min: 1, max: 128 }),
            bool('hasPartialResult', true),
        ]),
    },
    {
        state: 'tool_execution_end',
        version: '1.1.0',
        trigger: '工具执行结束',
        frequency: 'event',
        description: '工具执行结束：调用标识、错误标志、执行时长与用量。',
        payload: payload([
            str('toolCallId', true, { min: 1, max: 128 }),
            str('toolName', true, { min: 1, max: 128 }),
            bool('isError', true),
            int('contentPartCount', true, 0),
            int('durationMs', false, 0),
            int('usageTotalTokens', false, 0),
        ]),
    },
    // --- 模型与 thinking ------------------------------------------------------
    {
        state: 'model_select',
        version: '1.0.0',
        trigger: '模型切换（/model、Ctrl+P 循环、会话恢复）',
        frequency: 'event',
        description: '模型选择事件：provider/id 复合标识与来源。',
        payload: payload([
            str('model', true, { min: 1, max: 128, pattern: PROVIDER_MODEL_PATTERN }),
            str('previousModel', false, { min: 1, max: 128, pattern: PROVIDER_MODEL_PATTERN }),
            str('source', true, { enum: ['set', 'cycle', 'restore'] }),
        ]),
    },
    {
        state: 'thinking_level_select',
        version: '1.0.0',
        trigger: 'thinking 级别切换',
        frequency: 'event',
        description: 'thinking 级别事件：当前与上一级别。',
        payload: payload([
            str('level', true, { min: 1, max: 32 }),
            str('previousLevel', true, { min: 1, max: 32 }),
        ]),
    },
    // --- 用户输入与工具调用 ----------------------------------------------------
    {
        state: 'user_bash',
        version: '1.0.0',
        trigger: '用户以 ! 或 !! 前缀执行 bash 命令',
        frequency: 'event',
        description: '用户 bash 事件：命令长度（不含内容）、排除标志、目录。',
        payload: payload([
            int('commandLength', true, 0),
            bool('excludeFromContext', true),
            str('cwd', true, { min: 1, max: 4096 }),
        ]),
    },
    {
        state: 'input',
        version: '1.0.0',
        trigger: '用户输入接收后、agent 处理前',
        frequency: 'event',
        description: '输入事件：文本长度（不含内容）、图片数、来源。',
        payload: payload([
            int('textLength', true, 0),
            int('imageCount', true, 0),
            str('source', true, { enum: ['interactive', 'rpc', 'extension'] }),
            str('streamingBehavior', false, { enum: ['steer', 'followUp'] }),
        ]),
    },
    {
        state: 'tool_call',
        version: '1.0.0',
        trigger: '工具执行前（可阻止；参数可变）',
        frequency: 'event',
        description: '工具调用事件：调用标识与输入键名（不含输入值）。',
        payload: payload([
            ...toolCallIdFields,
            arr('inputKeys', str('inputKey', false, { min: 1, max: 64 }), true, { max: 64 }),
        ]),
    },
    {
        state: 'tool_result',
        version: '1.0.0',
        trigger: '工具执行后（可修改结果）',
        frequency: 'event',
        description: '工具结果事件：调用标识、错误标志、内容分片数（不含内容）。',
        payload: payload([
            str('toolCallId', true, { min: 1, max: 128 }),
            str('toolName', true, { min: 1, max: 128 }),
            bool('isError', true),
            int('usageTotalTokens', false, 0),
            int('contentPartCount', true, 0),
            bool('structuredContent', true),
        ]),
    },
    // --- 周期采样状态 ----------------------------------------------------------
    {
        state: 'agent_snapshot',
        version: '1.1.0',
        trigger: '每 reportIntervalMs（默认 30s）；session_start 与 agent_end 边界补采',
        frequency: 'periodic',
        description: 'agent 环境快照：ExtensionContext 可采样字段全集 + client 传输健康。',
        payload: payload([
            str('sessionId', false, { min: 0, max: 256 }),
            str('sessionName', false, { min: 0, max: 256 }),
            str('cwd', true, { min: 1, max: 4096 }),
            str('mode', true, { enum: ['tui', 'rpc', 'json', 'print'] }),
            bool('hasUI', true),
            bool('isProjectTrusted', true),
            bool('isIdle', true),
            bool('hasPendingMessages', true),
            str('model', false, { min: 1, max: 128, pattern: PROVIDER_MODEL_PATTERN }),
            str('thinkingLevel', false, { min: 1, max: 32 }),
            obj('contextUsage', [
                { name: 'tokens', type: 'integer', required: false, nullable: true, min: 0 },
                int('contextWindow', false, 0),
                num('percent', false, 0, 100, { nullable: true }),
            ], false),
            obj('transport', [
                int('dropped', false, 0),
                int('droppedRejected', false, 0),
                int('flushFailures', false, 0),
                bool('unreachable', false),
                { name: 'unreachableSince', type: 'integer', required: false, nullable: true, min: 0 },
            ], false),
            int('activeToolCount', true, 0),
            str('piVersion', false, { min: 1, max: 64 }),
            int('uptimeMs', true, 0),
        ]),
    },
];
/** 状态注册表：状态标识 → 契约。 */
export const STATE_REGISTRY = new Map(CONTRACTS.map((contract) => [contract.state, contract]));
/** 全部状态标识（与《手册》一一对应，共 42 项）。 */
export const STATE_IDS = CONTRACTS.map((contract) => contract.state);
/** 契约查询：不存在返回 undefined（调用方按 E_UNKNOWN_STATE 处理）。 */
export function getContract(state) {
    return STATE_REGISTRY.get(state);
}
export function isKnownState(state) {
    return STATE_REGISTRY.has(state);
}
//# sourceMappingURL=contracts.js.map
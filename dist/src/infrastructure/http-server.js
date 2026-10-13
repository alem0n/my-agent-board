/**
 * BoardHttpServer：server 端 HTTP 端点实现（infrastructure 层）。
 *
 * 职责契约：
 * - 基于 node:http（零新增运行时依赖），路由见 docs/DESIGN.md §6.1。
 * - 协议/契约校验 → AgentRegistry 摄入；非法请求返回结构化错误码。
 * - 错误响应统一为 { error:{ code, message, details? } }；批量拒绝返回 { ok:false, rejected:[...] }。
 *
 * 端点：
 *   POST /v1/report              单信封上报
 *   POST /v1/report/batch        批量上报（原子批：任一非法整体拒绝并逐条返回）
 *   GET  /v1/agents              agent 列表
 *   GET  /v1/agents/:uuid        单 agent 注册记录 + 逐状态最新载荷
 *   GET  /v1/agents/:uuid/history?state=&limit=&since=   历史记录
 *   DELETE /v1/agents/:uuid      删除 agent 条目（治理操作：请求即授权，无本地研判）
 *   POST /v1/heartbeat           进程级心跳：更新 lastHeartbeat（REQ-013；不创建记录）
 *   GET  /v1/health              健康检查
 *   GET  / 或 /ui                内置 Web UI（仅 --web 启用时；否则 404）
 */
import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WEB_UI_HTML } from './web-ui-asset.js';
import { PROTOCOL_VERSION } from '../domain/contracts.js';
import { ERROR_CODES } from '../domain/errors.js';
import { validateEnvelope, UUID_PATTERN } from '../domain/validation.js';
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_BATCH_REPORTS = 512;
const MAX_HISTORY_LIMIT = 1000;
/** 静态路径 → 允许方法。agent 动态路由（/v1/agents/:uuid[/history]）单独匹配。
 *  用 Map 而非对象字面量：避免 path 命中 Object.prototype 属性名（如 /constructor）
 *  时取到继承值而抛 TypeError（→ 500 而非 404）。 */
const STATIC_ROUTES = new Map([
    ['/v1/health', ['GET']],
    ['/v1/agents', ['GET']],
    ['/v1/report', ['POST']],
    ['/v1/report/batch', ['POST']],
    ['/v1/heartbeat', ['POST']],
]);
export class BoardHttpServer {
    options;
    host;
    port;
    registry;
    logger;
    server;
    startedAt;
    constructor(options) {
        this.host = options.host;
        this.port = options.port;
        this.registry = options.registry;
        this.logger = options.logger;
        this.options = {
            now: options.now ?? (() => Date.now()),
            maxReportAgeMs: options.maxReportAgeMs ?? 7 * 24 * 60 * 60 * 1000,
            webUi: options.webUi ?? false,
        };
        // 与注入的 now 一致（测试可控行运行时长）。
        this.startedAt = this.options.now();
    }
    /** 启动监听。返回实际监听地址（port=0 时为系统分配端口）。 */
    async start() {
        if (this.server !== undefined) {
            throw new Error('server already started');
        }
        const server = http.createServer((request, response) => {
            // 处理器内部已有 try/catch；此处兜底防御性 catch，避免任何 reject 成为
            // unhandled rejection（Node 默认终止进程）。
            void this.handleRequest(request, response).catch((error) => {
                this.logger.error('server.requestError', { error: String(error) });
                this.writeJsonSafe(response, 500, this.errorBody(ERROR_CODES.INTERNAL, 'internal server error'));
            });
        });
        this.server = server;
        await new Promise((resolve, reject) => {
            server.once('error', (error) => {
                this.server = undefined;
                reject(new Error(`server listen failed: ${error.message}`));
            });
            server.listen(this.port, this.host, () => resolve());
        });
        const address = server.address();
        const actualPort = typeof address === 'object' && address !== null ? address.port : this.port;
        return { host: this.host, port: actualPort };
    }
    async stop() {
        const server = this.server;
        if (server === undefined) {
            return;
        }
        await new Promise((resolve, reject) => {
            server.close((error) => (error === undefined ? resolve() : reject(error)));
        });
        this.server = undefined;
    }
    get uptimeMs() {
        return this.options.now() - this.startedAt;
    }
    // ---------------------------------------------------------------------------
    // 路由
    // ---------------------------------------------------------------------------
    async handleRequest(request, response) {
        try {
            const url = new URL(request.url ?? '/', 'http://localhost');
            const method = request.method ?? 'GET';
            const path = url.pathname;
            if (this.options.webUi && (path === '/' || path === '/ui')) {
                if (method === 'GET') {
                    this.writeHtml(response, WEB_UI_HTML);
                    return;
                }
                this.methodNotAllowed(response, method, path);
                return;
            }
            // agent 动态路由：/v1/agents/:uuid 与 /v1/agents/:uuid/history 单次匹配。
            const agentRoute = /^\/v1\/agents\/([^/]+)(\/history)?$/.exec(path);
            if (agentRoute !== null) {
                const uuid = decodeRouteUuid(agentRoute[1] ?? '');
                if (uuid === undefined) {
                    this.writeJson(response, 404, this.errorBody(ERROR_CODES.NOT_FOUND, `no route for ${method} ${path}`));
                    return;
                }
                const isHistory = agentRoute[2] === '/history';
                if (method === 'GET') {
                    const result = isHistory ? this.agentHistory(uuid, url) : this.agentRecord(uuid);
                    this.writeJson(response, result.status, result.body);
                    return;
                }
                if (method === 'DELETE' && !isHistory) {
                    const deleted = this.registry.delete(uuid);
                    if (!deleted) {
                        this.writeJson(response, 404, this.errorBody(ERROR_CODES.NOT_FOUND, `agent ${uuid} not found`));
                        return;
                    }
                    this.writeJson(response, 200, { uuid, deleted: true });
                    return;
                }
                // /history 为只读资源：DELETE 与其他方法 → 405。
                this.methodNotAllowed(response, method, path);
                return;
            }
            // 静态路由：路径已知 → 方法不匹配为 405；路径未知 → 404。
            const allowed = STATIC_ROUTES.get(path);
            if (allowed === undefined) {
                this.writeJson(response, 404, this.errorBody(ERROR_CODES.NOT_FOUND, `no route for ${method} ${path}`));
                return;
            }
            if (!allowed.includes(method)) {
                this.methodNotAllowed(response, method, path);
                return;
            }
            switch (path) {
                case '/v1/health':
                    this.writeJson(response, 200, this.healthBody());
                    return;
                case '/v1/agents':
                    this.writeJson(response, 200, { agents: this.registry.list(this.options.now()) });
                    return;
                case '/v1/report': {
                    const result = await this.handleSingleReport(request);
                    this.writeJson(response, result.status, result.body);
                    return;
                }
                case '/v1/report/batch': {
                    const result = await this.handleBatchReport(request);
                    this.writeJson(response, result.status, result.body);
                    return;
                }
                case '/v1/heartbeat': {
                    const result = await this.handleHeartbeat(request);
                    this.writeJson(response, result.status, result.body);
                    return;
                }
            }
        }
        catch (error) {
            this.logger.error('server.requestError', { error: String(error) });
            // 响应可能已被销毁（客户端断连）：防御性写入不传播错误。
            this.writeJsonSafe(response, 500, this.errorBody(ERROR_CODES.INTERNAL, 'internal server error'));
        }
    }
    methodNotAllowed(response, method, path) {
        this.writeJson(response, 405, this.errorBody(ERROR_CODES.METHOD_NOT_ALLOWED, `method ${method} not allowed on ${path}`));
    }
    writeHtml(response, body) {
        response.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'content-length': Buffer.byteLength(body, 'utf8'),
        });
        response.end(body);
    }
    async handleSingleReport(request) {
        const body = await this.readBody(request);
        if (!body.ok) {
            return { status: body.status, body: body.error };
        }
        const envelope = body.value;
        const validation = validateEnvelope(envelope, {
            now: this.options.now(),
            maxReportAgeMs: this.options.maxReportAgeMs,
        });
        if (!validation.ok) {
            const mapped = mapValidationErrors(validation.errors);
            return {
                status: 400,
                body: this.errorBody(mapped.code, mapped.message, { errors: validation.errors }),
            };
        }
        const ingest = this.registry.ingest(envelope, this.options.now());
        return {
            status: 200,
            body: {
                ok: true,
                uuid: ingest.uuid,
                assigned: ingest.assigned,
            },
        };
    }
    async handleBatchReport(request) {
        const body = await this.readBody(request);
        if (!body.ok) {
            return { status: body.status, body: body.error };
        }
        const batch = body.value;
        if (typeof batch !== 'object' || batch === null || !Array.isArray(batch['reports'])) {
            return {
                status: 400,
                body: this.errorBody(ERROR_CODES.INVALID_ENVELOPE, 'batch body must be { reports: Envelope[] }'),
            };
        }
        const reports = batch['reports'];
        if (reports.length > MAX_BATCH_REPORTS) {
            return {
                status: 413,
                body: this.errorBody(ERROR_CODES.BATCH_TOO_LARGE, `batch exceeds ${MAX_BATCH_REPORTS} reports`),
            };
        }
        const rejected = [];
        const valid = [];
        for (const [index, report] of reports.entries()) {
            const validation = validateEnvelope(report, {
                now: this.options.now(),
                maxReportAgeMs: this.options.maxReportAgeMs,
            });
            if (!validation.ok) {
                const mapped = mapValidationErrors(validation.errors);
                rejected.push({
                    index,
                    code: mapped.code,
                    message: mapped.message,
                    ...(typeof report === 'object' &&
                        report !== null &&
                        !Array.isArray(report) &&
                        typeof report['state'] === 'string'
                        ? { state: report['state'] }
                        : {}),
                });
                continue;
            }
            valid.push(report);
        }
        if (rejected.length > 0) {
            // 原子批：任一非法即整体拒绝，client 剔除毒信后重试剩余。
            return { status: 400, body: { ok: false, rejected } };
        }
        // 以请求为信任单位：无 uuid 的信封共用本批首个 uuid（首信封携带则沿用，否则生成一次）。
        // server 不做身份研判（无 sticky）：身份由 client 在后续请求中持续携带该 uuid。
        const firstUuid = valid[0]?.agent.uuid;
        // 请求级 assigned：本批 uuid 由 server 生成时 client 需采用。stamp 后信封均携带
        // uuid，逐条 ingest 的 assigned 恒为 false，无需再逐条合并。
        const assigned = valid.length > 0 && firstUuid === undefined;
        // 空批量无 uuid 可采用：uuid 为空串。
        const requestUuid = firstUuid ?? (valid.length > 0 ? randomUUID() : '');
        const stamped = valid.map((envelope) => envelope.agent.uuid === undefined
            ? { ...envelope, agent: { ...envelope.agent, uuid: requestUuid } }
            : envelope);
        let uuid = '';
        let accepted = 0;
        for (const envelope of stamped) {
            const ingest = this.registry.ingest(envelope, this.options.now());
            if (uuid === '') {
                uuid = ingest.uuid;
            }
            accepted += 1;
        }
        return {
            status: 200,
            body: {
                ok: true,
                accepted,
                uuid,
                assigned,
            },
        };
    }
    healthBody() {
        return {
            status: 'ok',
            protocolVersion: PROTOCOL_VERSION,
            agents: this.registry.list(this.options.now()).length,
            uptimeMs: this.uptimeMs,
        };
    }
    agentRecord(uuid) {
        const body = this.registry.detail(uuid, this.options.now());
        if (body === undefined) {
            return {
                status: 404,
                body: this.errorBody(ERROR_CODES.NOT_FOUND, `agent '${uuid}' not found`),
            };
        }
        return { status: 200, body };
    }
    async handleHeartbeat(request) {
        const body = await this.readBody(request);
        if (!body.ok) {
            return { status: body.status, body: body.error };
        }
        const value = body.value;
        const uuid = value?.['uuid'];
        if (typeof uuid !== 'string' || !UUID_PATTERN.test(uuid)) {
            return {
                status: 400,
                body: this.errorBody(ERROR_CODES.INVALID_ENVELOPE, 'heartbeat body must be { uuid: string }'),
            };
        }
        if (!this.registry.heartbeat(uuid, this.options.now())) {
            return {
                status: 404,
                body: this.errorBody(ERROR_CODES.NOT_FOUND, `agent '${uuid}' not found`),
            };
        }
        return { status: 200, body: { ok: true, uuid } };
    }
    agentHistory(uuid, url) {
        const stateParam = url.searchParams.get('state') ?? undefined;
        const limitParam = url.searchParams.get('limit');
        const sinceParam = url.searchParams.get('since');
        const limit = limitParam === null ? undefined : Number.parseInt(limitParam, 10);
        const since = sinceParam === null ? undefined : Number.parseInt(sinceParam, 10);
        const result = this.registry.history(uuid, {
            ...(stateParam === undefined || stateParam === '' ? {} : { state: stateParam }),
            ...(Number.isFinite(limit)
                ? { limit: Math.min(MAX_HISTORY_LIMIT, Math.max(1, limit)) }
                : {}),
            ...(Number.isFinite(since) ? { since: since } : {}),
        });
        if (result === undefined) {
            return {
                status: 404,
                body: this.errorBody(ERROR_CODES.NOT_FOUND, `agent '${uuid}' not found`),
            };
        }
        return { status: 200, body: result };
    }
    // ---------------------------------------------------------------------------
    // 工具
    // ---------------------------------------------------------------------------
    async readBody(request) {
        const chunks = [];
        let total = 0;
        for await (const chunk of request) {
            total += chunk.length;
            if (total > MAX_BODY_BYTES) {
                return {
                    ok: false,
                    status: 413,
                    error: this.errorBody(ERROR_CODES.BATCH_TOO_LARGE, `request body exceeds ${MAX_BODY_BYTES} bytes`),
                };
            }
            chunks.push(chunk);
        }
        const text = Buffer.concat(chunks).toString('utf8');
        if (text.trim().length === 0) {
            return {
                ok: false,
                status: 400,
                error: this.errorBody(ERROR_CODES.INVALID_ENVELOPE, 'request body is empty'),
            };
        }
        try {
            return { ok: true, value: JSON.parse(text) };
        }
        catch (error) {
            return {
                ok: false,
                status: 400,
                error: this.errorBody(ERROR_CODES.INVALID_ENVELOPE, `request body is not valid JSON: ${String(error)}`),
            };
        }
    }
    errorBody(code, message, details) {
        return { error: { code, message, ...(details === undefined ? {} : details) } };
    }
    writeJson(response, status, body) {
        const payload = JSON.stringify(body);
        response.writeHead(status, {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
        });
        response.end(payload);
    }
    /** 防御性写入：响应可能已销毁（客户端断连），失败仅记录不传播。 */
    writeJsonSafe(response, status, body) {
        try {
            this.writeJson(response, status, body);
        }
        catch (error) {
            this.logger.error('server.writeError', { error: String(error) });
        }
    }
}
/** 解码路径段中的 uuid；非法百分编码返回 undefined（路由层判 404，不当 500）。 */
function decodeRouteUuid(raw) {
    try {
        return decodeURIComponent(raw);
    }
    catch {
        return undefined;
    }
}
/** 将字段级校验错误映射为协议层错误码（docs/DESIGN.md §6.2）。 */
function mapValidationErrors(errors) {
    const first = errors[0];
    if (first === undefined) {
        return { code: ERROR_CODES.INVALID_ENVELOPE, message: 'validation failed' };
    }
    if (first.code === ERROR_CODES.UNKNOWN_STATE || first.field === 'state') {
        return { code: ERROR_CODES.UNKNOWN_STATE, message: first.message };
    }
    if (first.field === 'protocolVersion') {
        return { code: ERROR_CODES.UNSUPPORTED_PROTOCOL, message: first.message };
    }
    if (first.code === ERROR_CODES.STALE_REPORT) {
        return { code: ERROR_CODES.STALE_REPORT, message: first.message };
    }
    if (first.field.startsWith('agent.')) {
        return { code: ERROR_CODES.AGENT_IDENTITY, message: first.message };
    }
    if (first.field === 'payload' || first.field.startsWith('payload.')) {
        return { code: ERROR_CODES.INVALID_PAYLOAD, message: first.message };
    }
    return { code: ERROR_CODES.INVALID_ENVELOPE, message: first.message };
}
//# sourceMappingURL=http-server.js.map
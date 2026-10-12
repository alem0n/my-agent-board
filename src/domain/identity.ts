/**
 * 身份规则：agent 身份字段的生成与降级（领域纯函数）。
 *
 * 职责契约：
 * - name 未设置时回退当前 session id（任务四、4d）。
 * - name 与 session id 皆不可用时返回失败（由调用方记日志并丢弃该条上报，不静默）。
 * 设计文档：docs/DESIGN.md §5。
 */
import type { PiEnvironmentSnapshot } from './pi-env.js';

export interface ResolvedIdentity {
  name: string;
  cwd: string;
  sessionId?: string;
}

export type ResolveResult =
  { ok: true; identity: ResolvedIdentity } | { ok: false; reason: 'name_missing' | 'cwd_missing' };

/**
 * 解析单条上报的身份字段。
 *
 * @param configuredName 配置文件中的 name（空串视为未设置）。
 * @param env 当前 pi 环境快照。
 */
export function resolveIdentity(
  configuredName: string | undefined,
  env: PiEnvironmentSnapshot,
): ResolveResult {
  const cwd = env.cwd;
  if (typeof cwd !== 'string' || cwd.length < 1) {
    return { ok: false, reason: 'cwd_missing' };
  }

  const name =
    typeof configuredName === 'string' && configuredName.trim().length >= 1
      ? configuredName
      : env.sessionId;
  if (typeof name !== 'string' || name.length < 1) {
    return { ok: false, reason: 'name_missing' };
  }

  return {
    ok: true,
    identity: { name, cwd, ...(env.sessionId === undefined ? {} : { sessionId: env.sessionId }) },
  };
}

/** 持久化的客户端身份文件内容。 */
export interface PersistedIdentity {
  uuid: string;
  assignedAt: number;
  serverUrl?: string;
}

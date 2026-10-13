/**
 * server 配置层：解析命令行参数（组合层注入）。
 * 职责契约：仅做配置读取与校验，不含业务逻辑，不访问外部服务。
 * 参数：--port / --host / --log-level / --web。非法值 → 默认值 + 明确日志（启动日志含实际值）。
 * --web 为开关参数（裸 --web 或 --web=false），控制内置 Web UI 是否挂载。
 * 值参数同时支持 `--port=7899` 与 `--port 7899` 两种形式。
 */
import process from 'node:process';

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  /** 挂载内置 Web UI（GET / 与 /ui）。默认关闭：用户可自行可视化。 */
  readonly webUi: boolean;
}

const DEFAULTS: ServerConfig = {
  host: '127.0.0.1',
  port: 7878,
  logLevel: 'info',
  webUi: false,
};

/** 期待值的参数（其他裸 --key 一律按开关处理，不进入值解析）。 */
const VALUE_KEYS: ReadonlySet<string> = new Set(['port', 'host', 'log-level']);

function parseArgs(argv: readonly string[]): Record<string, string> {
  const args: Record<string, string> = {};
  const rest = argv.slice(2);
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] ?? '';
    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (match !== null) {
      args[match[1] ?? ''] = match[2] ?? '';
      continue;
    }
    const bare = /^--([a-z-]+)$/.exec(arg);
    if (bare === null) {
      continue;
    }
    const key = bare[1] ?? '';
    if (VALUE_KEYS.has(key)) {
      // 空格形式：值取下一个参数；下一个不存在或本身就是 --flag 则按未设置处理（用默认值）。
      const value = rest[index + 1];
      if (value !== undefined && !value.startsWith('--')) {
        args[key] = value;
        index += 1;
      }
      continue;
    }
    // 裸开关参数（如 --web）记为 '1'。
    args[key] = '1';
  }
  return args;
}

export function loadServerConfig(argv: readonly string[] = process.argv): ServerConfig {
  const args = parseArgs(argv);

  const port = Number.parseInt(args['port'] ?? '', 10);
  const host = args['host'];
  const logLevel = args['log-level'];
  const webRaw = args['web'];
  // 非法值一律视为关闭（opt-in 语义；启动日志会明确告知挂载状态）。
  const webUi =
    webRaw === undefined
      ? DEFAULTS.webUi
      : ['1', 'true', 'yes', 'on'].includes(webRaw.toLowerCase());

  return {
    host: typeof host === 'string' && host.length >= 1 && host.length <= 255 ? host : DEFAULTS.host,
    port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULTS.port,
    logLevel:
      logLevel === 'trace' ||
      logLevel === 'debug' ||
      logLevel === 'info' ||
      logLevel === 'warn' ||
      logLevel === 'error'
        ? logLevel
        : DEFAULTS.logLevel,
    webUi,
  };
}

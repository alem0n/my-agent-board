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
  /** 用户是否显式提供了 --log-level（决定是否覆盖环境变量种子值）。 */
  readonly logLevelProvided: boolean;
  /** 参数回退提示（非法值回退到默认值时生成，由入口记 warn 日志）。 */
  readonly warnings: readonly string[];
}

const DEFAULTS = {
  host: '127.0.0.1',
  port: 7878,
  logLevel: 'info' as const,
  webUi: false,
};

/** 期待值的参数（其他裸 --key 一律按开关处理，不进入值解析）。 */
const VALUE_KEYS: ReadonlySet<string> = new Set(['port', 'host', 'log-level']);

/** 合法日志级别取值。 */
const LOG_LEVEL_VALUES = ['trace', 'debug', 'info', 'warn', 'error'] as const;

type LogLevelValue = (typeof LOG_LEVEL_VALUES)[number];

function isLogLevel(value: string): value is LogLevelValue {
  return (LOG_LEVEL_VALUES as readonly string[]).includes(value);
}

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

  const warnings: string[] = [];

  const portRaw = args['port'];
  const port = Number.parseInt(portRaw ?? '', 10);
  if (portRaw !== undefined && !(Number.isInteger(port) && port >= 1 && port <= 65535)) {
    warnings.push(`invalid --port '${portRaw}', using ${DEFAULTS.port}`);
  }

  const hostRaw = args['host'];
  if (hostRaw !== undefined && !(hostRaw.length >= 1 && hostRaw.length <= 255)) {
    warnings.push(`invalid --host '${hostRaw}', using ${DEFAULTS.host}`);
  }

  const logLevelRaw = args['log-level'];
  const logLevelProvided = logLevelRaw !== undefined;
  const logLevelValid = logLevelProvided && isLogLevel(logLevelRaw);
  if (logLevelProvided && !logLevelValid) {
    warnings.push(`invalid --log-level '${logLevelRaw}', using ${DEFAULTS.logLevel}`);
  }

  const webRaw = args['web'];
  const webUi =
    webRaw === undefined
      ? DEFAULTS.webUi
      : ['1', 'true', 'yes', 'on'].includes(webRaw.toLowerCase());
  if (
    webRaw !== undefined &&
    !webUi &&
    !['0', 'false', 'no', 'off'].includes(webRaw.toLowerCase())
  ) {
    warnings.push(`invalid --web '${webRaw}', treated as off`);
  }

  return {
    host:
      typeof hostRaw === 'string' && hostRaw.length >= 1 && hostRaw.length <= 255
        ? hostRaw
        : DEFAULTS.host,
    port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULTS.port,
    logLevel:
      logLevelRaw !== undefined && isLogLevel(logLevelRaw) ? logLevelRaw : DEFAULTS.logLevel,
    webUi,
    logLevelProvided,
    warnings,
  };
}

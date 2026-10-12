/**
 * server 配置层：解析命令行参数（组合层注入）。
 *
 * 职责契约：仅做配置读取与校验，不含业务逻辑，不访问外部服务。
 * 参数：--port / --host / --data-dir / --log-level。非法值 → 默认值 + 明确日志。
 */
import process from 'node:process';

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly dataDir: string;
  readonly logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error';
}

const DEFAULTS: ServerConfig = {
  host: '127.0.0.1',
  port: 7878,
  dataDir: 'data',
  logLevel: 'info',
};

function parseArgs(argv: readonly string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (const arg of argv.slice(2)) {
    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (match !== null) {
      args[match[1] ?? ''] = match[2] ?? '';
    }
  }
  return args;
}

export function loadServerConfig(argv: readonly string[] = process.argv): ServerConfig {
  const args = parseArgs(argv);

  const port = Number.parseInt(args['port'] ?? '', 10);
  const host = args['host'];
  const dataDir = args['data-dir'];
  const logLevel = args['log-level'];

  return {
    host: typeof host === 'string' && host.length >= 1 && host.length <= 255 ? host : DEFAULTS.host,
    port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULTS.port,
    dataDir: typeof dataDir === 'string' && dataDir.length >= 1 ? dataDir : DEFAULTS.dataDir,
    logLevel:
      logLevel === 'trace' ||
      logLevel === 'debug' ||
      logLevel === 'info' ||
      logLevel === 'warn' ||
      logLevel === 'error'
        ? logLevel
        : DEFAULTS.logLevel,
  };
}

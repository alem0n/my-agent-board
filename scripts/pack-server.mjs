#!/usr/bin/env node
/**
 * pack-server：生成自包含的 server 部署产物（build/server/）。
 *
 * 编译 src（tsc → dist）后，从 server 入口 src/index.ts 出发做模块闭包扫描，
 * 仅复制闭包内的编译结果（不含 client 扩展 / 模拟器 / 演示），
 * 配以最小 package.json（pino 依赖 + 启动脚本）。
 *
 * 用法：node scripts/pack-server.mjs [--out build/server]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import { spawnSync } from 'node:child_process';
import { collectClosure } from './pack-client.mjs';

const __filename = url.fileURLToPath(new URL(import.meta.url));
const ROOT = path.resolve(path.dirname(__filename), '..');
const ENTRY = path.join(ROOT, 'src', 'index.ts');
const DIST = path.join(ROOT, 'dist');

/** client / 非 server 模块（闭包中出现即视为分离破坏）。 */
export const CLIENT_MODULES = [
  'extension/agent-board.ts',
  'src/simulate.ts',
  'src/infrastructure/pi-extension.ts',
  'src/infrastructure/simulator.ts',
  'src/infrastructure/http-client.ts',
  'src/infrastructure/client-config-loader.ts',
  'src/services/reporter.ts',
  'src/services/mapper.ts',
  'src/services/retry.ts',
];

function artifactPackageJson() {
  const root = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  return {
    name: 'my-agent-board-server',
    version: root.version,
    description: 'pi agent 状态监控 server（自包含部署产物；client 扩展单独部署）',
    type: 'module',
    main: 'dist/src/index.js',
    scripts: {
      start: 'node dist/src/index.js',
    },
    dependencies: {
      pino: root.dependencies?.pino ?? '^9.5.0',
    },
    engines: { node: '>=22' },
  };
}

function main() {
  const outIndex = process.argv.indexOf('--out');
  const outArg = outIndex >= 0 ? process.argv[outIndex + 1] : undefined;
  const outDir = path.resolve(ROOT, outArg ?? 'build/server');
  // 护栏：产物目录必须位于仓库内，防止误写仓库外文件。
  if (!outDir.startsWith(ROOT + path.sep)) {
    console.error(`refusing to write outside repo root: ${outDir}`);
    process.exit(1);
  }

  const compile = spawnSync(
    process.execPath,
    [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '--outDir', 'dist'],
    { cwd: ROOT, stdio: 'inherit' },
  );
  if (compile.status !== 0) {
    console.error('tsc failed; refusing to pack');
    process.exit(1);
  }

  const { files, unresolved } = collectClosure(ENTRY);
  const clientLeaks = files.filter((file) =>
    CLIENT_MODULES.includes(path.relative(ROOT, file).replaceAll(path.sep, '/')),
  );
  if (clientLeaks.length > 0) {
    console.error('server closure contains client modules:', clientLeaks);
    process.exit(1);
  }
  if (unresolved.length > 0) {
    console.error('unresolved imports:', JSON.stringify(unresolved));
    process.exit(1);
  }

  fs.rmSync(outDir, { recursive: true, force: true });
  let copied = 0;
  for (const file of files) {
    const relative = path.relative(ROOT, file).replace(/\.ts$/, '.js');
    const source = path.join(DIST, relative);
    if (!fs.existsSync(source)) {
      console.error(`missing compiled output for ${relative}; run tsc first`);
      process.exit(1);
    }
    const target = path.join(outDir, 'dist', relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    copied += 1;
  }
  fs.writeFileSync(
    path.join(outDir, 'package.json'),
    `${JSON.stringify(artifactPackageJson(), null, 2)}\n`,
  );

  const asset = (source, target = source) => {
    const sourcePath = path.join(ROOT, source);
    if (fs.existsSync(sourcePath)) {
      fs.copyFileSync(sourcePath, path.join(outDir, target));
    }
  };
  asset('README.server.md', 'README.md');
  asset('LICENSE');

  console.log(`server artifact: ${outDir}`);
  console.log(`modules: ${copied} (entry: dist/src/index.js)`);
  console.log('runtime deps: pino');
}

const isMain = process.argv[1] === __filename;
if (isMain) {
  main();
}

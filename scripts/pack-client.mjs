#!/usr/bin/env node
/**
 * pack-client：生成自包含的 client 部署产物（build/client/）。
 *
 * 从扩展入口 extension/agent-board.ts 出发做模块闭包扫描（仅相对导入），
 * 复制闭包内的 TypeScript 源文件并生成最小 package.json（pi 清单 + peer 依赖），
 * 产物不含任何 server / 测试 / 演示代码，可直接 `pi install build/client`。
 *
 * 用法：node scripts/pack-client.mjs [--out build/client]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

const __filename = url.fileURLToPath(new URL(import.meta.url));
const ROOT = path.resolve(path.dirname(__filename), '..');
const ENTRY = path.join(ROOT, 'extension', 'agent-board.ts');

/** server / 非客户端模块（闭包中出现即视为分离破坏）。 */
export const SERVER_MODULES = [
  'src/index.ts',
  'src/simulate.ts',
  'src/config.ts',
  'src/logger.ts',
  'src/infrastructure/http-server.ts',
  'src/infrastructure/registry-file-store.ts',
  'src/infrastructure/index.ts',
  'src/services/registry.ts',
  'src/services/index.ts',
];

/** 提取文件中全部相对导入（jiti 语义：.js 后缀映射到 .ts）。 */
export function extractRelativeImports(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  const imports = [];
  const pattern = /(?:^|\n)\s*import\s+(?:[\s\S]*?\s+from\s+)?['"](\.[^'"]+)['"]/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    imports.push(match[1]);
  }
  // export ... from '...'
  const exportPattern = /(?:^|\n)\s*export\s+(?:[\s\S]*?\s+from\s+)?['"](\.[^'"]+)['"]/g;
  while ((match = exportPattern.exec(source)) !== null) {
    imports.push(match[1]);
  }
  return imports;
}

/** 将导入说明符解析为磁盘文件（.js → .ts 映射）。 */
export function resolveImport(fromFile, specifier) {
  const dir = path.dirname(fromFile);
  const stripped = specifier.replace(/\.js$/, '');
  for (const candidate of [
    `${stripped}.ts`,
    `${stripped}.js`,
    path.join(stripped, 'index.ts'),
    path.join(stripped, 'index.js'),
  ]) {
    const resolved = path.resolve(dir, candidate);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      return resolved;
    }
  }
  return null;
}

/** 计算从入口出发的完整模块闭包。 */
export function collectClientClosure(entry = ENTRY) {
  const visited = new Set();
  const unresolved = [];
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop();
    if (visited.has(file)) {
      continue;
    }
    visited.add(file);
    for (const specifier of extractRelativeImports(file)) {
      const resolved = resolveImport(file, specifier);
      if (resolved === null) {
        unresolved.push({ file, specifier });
        continue;
      }
      if (!visited.has(resolved)) {
        stack.push(resolved);
      }
    }
  }
  return { files: [...visited].sort(), unresolved };
}

/** 产物 package.json（pi 清单 + 宿主 peer 依赖，无运行时依赖）。 */
function artifactPackageJson() {
  return {
    name: 'my-agent-board-client',
    version: '0.1.0',
    description: 'pi agent 状态监控 client（自包含部署产物；server 单独部署）',
    type: 'module',
    keywords: ['pi-package'],
    pi: {
      extensions: ['./extension/agent-board.ts'],
    },
    peerDependencies: {
      '@earendil-works/pi-coding-agent': '*',
    },
  };
}

function main() {
  const outIndex = process.argv.indexOf('--out');
  const outArg = outIndex >= 0 ? process.argv[outIndex + 1] : undefined;
  const outDir = path.resolve(ROOT, outArg ?? 'build/client');
  // 护栏：产物目录必须位于仓库内，防止误写仓库外文件。
  if (!outDir.startsWith(ROOT + path.sep)) {
    console.error(`refusing to write outside repo root: ${outDir}`);
    process.exit(1);
  }
  const { files, unresolved } = collectClientClosure();

  const serverLeaks = files.filter((file) =>
    SERVER_MODULES.includes(path.relative(ROOT, file).replaceAll(path.sep, '/')),
  );
  if (serverLeaks.length > 0) {
    console.error('client closure contains server modules:', serverLeaks);
    process.exit(1);
  }
  if (unresolved.length > 0) {
    console.error('unresolved imports:', JSON.stringify(unresolved));
    process.exit(1);
  }

  fs.rmSync(outDir, { recursive: true, force: true });
  for (const file of files) {
    const relative = path.relative(ROOT, file);
    const target = path.join(outDir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file, target);
  }
  fs.writeFileSync(
    path.join(outDir, 'package.json'),
    `${JSON.stringify(artifactPackageJson(), null, 2)}\n`,
  );

  console.log(`client artifact: ${outDir}`);
  console.log(`modules: ${files.length} (entry: extension/agent-board.ts)`);
  console.log('runtime deps: none (node builtins only)');
}

const isMain = process.argv[1] === __filename;
if (isMain) {
  main();
}

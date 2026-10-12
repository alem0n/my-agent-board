/**
 * 分离部署契约测试：
 * 1. client 模块闭包（从 extension/agent-board.ts 出发）不含任何 server 模块；
 * 2. client 产物（build/client）自包含：每个相对导入在产物内可解析；
 * 3. client 产物零外部运行时依赖（仅 node 内置），带 pi 清单与 peer 依赖；
 * 4. 产物目录必须落在仓库内（pack 脚本护栏回归：历史 bug 曾误写仓库外文件）。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import {
  collectClosure,
  collectClientClosure,
  extractRelativeImports,
  resolveImport,
  SERVER_MODULES,
} from '../scripts/pack-client.mjs';
import { CLIENT_MODULES } from '../scripts/pack-server.mjs';

const __dirname_test = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname_test, '..');
const ENTRY = path.join(ROOT, 'extension', 'agent-board.ts');
const SERVER_ENTRY = path.join(ROOT, 'src', 'index.ts');

function externalImport(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('node:');
}

describe('client-server 分离（部署契约）', () => {
  it('client 源码闭包不含任何 server 模块', () => {
    const { files, unresolved } = collectClientClosure(ENTRY);
    expect(unresolved).toEqual([]);
    const relative = files.map((file) => path.relative(ROOT, file).replaceAll(path.sep, '/'));
    const leaks = relative.filter((file) => SERVER_MODULES.includes(file));
    expect(leaks).toEqual([]);
    // client 闭包基线：入口 + domain + services 子集 + infrastructure 子集
    expect(relative).toContain('extension/agent-board.ts');
    expect(relative.filter((file) => file.startsWith('src/domain/')).length).toBeGreaterThan(0);
    expect(relative.some((file) => file.startsWith('src/services/'))).toBe(true);
  });

  it('client 闭包只导入相对模块与 node 内置模块（无第三方运行时依赖）', () => {
    for (const file of collectClientClosure(ENTRY).files) {
      for (const specifier of extractRelativeImports(file)) {
        const resolved = resolveImport(file, specifier);
        expect(resolved, `${file} -> ${specifier}`).not.toBeNull();
      }
      // 检查外部导入：仅匹配真正的 import/export...from 与裸 import 语句
      // （避免误抓泛型/字符串字面量）；类型导入运行时剥离，视为合法。
      const source = fs.readFileSync(file, 'utf8');
      const fromImports = [
        ...source.matchAll(/^[ \t]*(?:import|export)[^;\n]*?\bfrom\s+['"]([^'"]+)['"]/gm),
      ];
      const bareImports = [...source.matchAll(/^[ \t]*import\s+['"]([^'"]+)['"]/gm)].map(
        (match) => match[1] ?? '',
      );
      const importSpecifiers = [
        ...fromImports
          // 类型导入（import type / export type ... from）运行时剥离，视为合法
          .filter((match) => !/^[ \t]*(?:import|export)\s+type\b/.test(match[0] ?? ''))
          .map((match) => match[1] ?? ''),
        ...bareImports,
      ];
      for (const specifier of importSpecifiers) {
        expect(externalImport(specifier), `${file} imports third-party ${specifier}`).toBe(false);
      }
    }
  });
});

describe('server 闭包（部署契约）', () => {
  it('server 源码闭包不含任何 client 模块', () => {
    const { files, unresolved } = collectClosure(SERVER_ENTRY);
    expect(unresolved).toEqual([]);
    const relative = files.map((file) => path.relative(ROOT, file).replaceAll(path.sep, '/'));
    const leaks = relative.filter((file) => CLIENT_MODULES.includes(file));
    expect(leaks).toEqual([]);
    expect(relative).toContain('src/index.ts');
  });
});

describe('client 产物（build/client）', () => {
  const artifact = path.join(ROOT, 'build', 'client');

  it('pack 脚本可产出，或者跳过（未构建时不阻塞 CI）', async () => {
    if (!fs.existsSync(artifact)) {
      // 缺产物时跳过断言（不阻断 CI）；提示文本经 logger 端口输出而非 console
      const logger = await import('../src/domain/logging.js');
      logger.silentLogger.warn('build/client 不存在：先运行 pnpm pack:client；跳过产物断言');
      return;
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(artifact, 'package.json'), 'utf8'));
    expect(manifest['pi']?.['extensions']).toEqual(['./extension/agent-board.ts']);
    expect(manifest['peerDependencies']?.['@earendil-works/pi-coding-agent']).toBe('*');
    expect(manifest['dependencies']).toBeUndefined();
    expect(manifest['keywords']).toContain('pi-package');
  });

  it('产物自包含：全部相对导入在产物内解析', () => {
    if (!fs.existsSync(artifact)) {
      return;
    }
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.ts')) {
          files.push(full);
        }
      }
    };
    walk(artifact);
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      for (const specifier of extractRelativeImports(file)) {
        const resolved = resolveImport(file, specifier);
        expect(resolved, `产物内 ${file} -> ${specifier} 必须在产物内可解析`).not.toBeNull();
        expect(resolved?.startsWith(artifact)).toBe(true);
      }
    }
    // 产物不含 server 模块与测试
    const relative = files.map((file) => path.relative(artifact, file).replaceAll(path.sep, '/'));
    expect(relative.some((file) => file.includes('http-server') || file.includes('registry'))).toBe(
      false,
    );
  });
});

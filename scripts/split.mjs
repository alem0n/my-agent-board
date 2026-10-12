#!/usr/bin/env node
/**
 * split：把 client / server 产物发布为独立 orphan 分支。
 *
 * 模式同 gh-pages：orphan 分支无主仓历史，force 更新。
 * 用户 `git clone --depth 1 --branch client <url>` 只拿到 client 产物，
 * `--branch server` 只拿 server 产物，互不污染、不含源码与测试。
 *
 * 用法：
 *   node scripts/split.mjs client           # 重建 client 分支
 *   node scripts/split.mjs server           # 重建 server 分支
 *   node scripts/split.mjs client --push origin
 *   node scripts/split.mjs client --push origin --tag v0.1.0   # 打发布 tag（锁版本用）
 *
 * client 分支作为仓库默认分支时，--tag 产出可锁定的版本引用：
 *   git clone --depth 1 --branch v0.1.0 <url>
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as url from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

const KINDS = {
  client: { branch: 'client', dir: 'build/client', pack: 'pack-client.mjs' },
  server: { branch: 'server', dir: 'build/server', pack: 'pack-server.mjs' },
};

function git(args, options = {}) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', ...options });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr ?? ''}`);
  }
  return result.stdout.trim();
}

function ensureGitIdentity() {
  if (!git(['config', 'user.email'])) {
    git(['config', 'user.email', 'my-agent-board@localhost']);
    git(['config', 'user.name', 'my-agent-board release']);
    console.warn('git 身份未设置：已写入仓库局部默认值（my-agent-board release）');
  }
}

function main() {
  const kind = process.argv[2];
  const pushIndex = process.argv.indexOf('--push');
  const remote = pushIndex >= 0 ? process.argv[pushIndex + 1] : undefined;
  const tagIndex = process.argv.indexOf('--tag');
  const tag = tagIndex >= 0 ? process.argv[tagIndex + 1] : undefined;
  if (tag !== undefined && !/^v\d+\.\d+\.\d+$/.test(tag)) {
    console.error(`invalid tag (expect vX.Y.Z): ${tag}`);
    process.exit(1);
  }
  const spec = KINDS[kind];
  if (spec === undefined) {
    console.error(`usage: node scripts/split.mjs <client|server> [--push remote]`);
    process.exit(1);
  }
  ensureGitIdentity();

  // 1. 打包（产物脚本自带仓库内护栏）
  const pack = spawnSync(process.execPath, [path.join(ROOT, 'scripts', spec.pack)], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (pack.status !== 0) {
    process.exit(pack.status ?? 1);
  }
  const artifact = path.join(ROOT, spec.dir);
  if (!fs.existsSync(artifact) || fs.readdirSync(artifact).length === 0) {
    console.error(`artifact missing or empty: ${artifact}`);
    process.exit(1);
  }

  // 2. 临时 worktree 中重建 orphan 分支（不触碰主工作区）
  git(['rev-parse', '--show-toplevel']);
  // 分发分支为可重建产物，始终 force 更新（不存在时跳过删除）
  if (git(['branch', '--list', spec.branch]) !== '') {
    git(['branch', '-D', spec.branch]);
  }
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-split-'));
  try {
    git(['worktree', 'add', '--detach', worktree]);
    try {
      // orphan 首次提交保留 HEAD 暂存内容，需先清空再拷贝产物
      spawnSync('git', ['rm', '-rf', '-q', '.'], { cwd: worktree, encoding: 'utf8' });
      for (const entry of fs.readdirSync(artifact)) {
        fs.cpSync(path.join(artifact, entry), path.join(worktree, entry), { recursive: true });
      }
      const add = spawnSync('git', ['add', '-A'], { cwd: worktree, encoding: 'utf8' });
      if (add.status !== 0) {
        throw new Error(`git add failed: ${add.stderr}`);
      }
      const commit = spawnSync('git', ['commit', '-q', '-m', `${kind} release (built from main)`], {
        cwd: worktree,
        encoding: 'utf8',
      });
      if (commit.status !== 0) {
        throw new Error(`git commit failed: ${commit.stderr}`);
      }
      // worktree 上的 orphan 提交在分离 HEAD 上：建成分发分支
      const head = spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd: worktree,
        encoding: 'utf8',
      });
      if (head.status !== 0) {
        throw new Error('rev-parse HEAD failed');
      }
      git(['branch', '-f', spec.branch, head.stdout.trim()]);
    } finally {
      spawnSync('git', ['worktree', 'remove', '--force', worktree], { cwd: ROOT });
    }
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
  }

  const sha = git(['rev-parse', '--short', spec.branch]);
  const size = git(['ls-tree', '-r', '--name-only', spec.branch])
    .split('\n')
    .filter(Boolean).length;
  console.log(`${kind} branch: refs/heads/${spec.branch} (${sha}, ${size} files)`);

  if (remote !== undefined) {
    git(['push', '--force', remote, `${spec.branch}:refs/heads/${spec.branch}`]);
    console.log(`pushed ${spec.branch} -> ${remote}`);
  }
  if (tag !== undefined) {
    // 强制覆盖同名 tag：发布产物可重建（同 split 分支的 force 语义）
    git(['tag', '-f', tag, spec.branch]);
    console.log(`tagged ${spec.branch} as ${tag}`);
    if (remote !== undefined) {
      git(['push', '--force', remote, `refs/tags/${tag}`]);
      console.log(`pushed tag ${tag} -> ${remote}`);
    }
  }
}

main();

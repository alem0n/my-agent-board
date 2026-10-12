# TypeScript 模板质量门禁：统一入口
# 使用：make check（提交前必跑，CI 引用同一入口）
# 包管理器固定为 pnpm（见上级 AGENTS.md）

.PHONY: check precommit test lint typecheck fmt audit layers clean

check:  ## 一次性质量门禁（= pnpm check）
	pnpm check
precommit:  ## pre-commit 快速子集（依赖审计留 CI，避免提交卡顿）
	pnpm run lint && pnpm run typecheck && pnpm run format:check && pnpm run test:coverage

test:  ## 运行测试
	pnpm test

lint:  ## ESLint
	pnpm lint

typecheck:  ## tsc --noEmit
	pnpm typecheck

fmt:  ## Prettier 检查
	pnpm format:check

layers:  ## 分层依赖契约校验（dependency-cruiser）
	pnpm lint:layers

audit:  ## 生产依赖漏洞审计
	pnpm audit --prod

clean:
	rm -rf dist coverage node_modules

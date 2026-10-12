import { defineConfig } from 'vitest/config';

// 覆盖率阈值（初始默认值 80）：随项目成熟度调整
// 闭合「变更未加测试」漏洞：变更后即使旧测试全绿，未覆盖到阈值即失败
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    exclude: ['node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
      },
    },
  },
});

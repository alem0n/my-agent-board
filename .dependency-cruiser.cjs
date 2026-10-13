/**
 * dependency-cruiser 分层依赖契约：高内聚低耦合的机器校验
 * 依赖方向单向指向 domain：infrastructure → services → domain
 * 运行：pnpm lint:layers
 *
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      name: 'layer-boundary-domain',
      comment: 'domain 层不得导入 services / infrastructure（领域核心须无外部依赖）',
      severity: 'error',
      from: { path: '^src/domain' },
      to: { path: '^src/(services|infrastructure)' },
    },
    {
      name: 'layer-boundary-services',
      comment: 'services 层不得直接导入 infrastructure（须通过接口依赖倒置）',
      severity: 'error',
      from: { path: '^src/services' },
      to: { path: '^src/infrastructure' },
    },
    {
      name: 'no-circular',
      comment: '禁止循环依赖（任何层）',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'client-server-separation',
      comment: 'client 执行路径模块不得导入 server 模块（分离部署契约，见 docs/DESIGN.md §1.5）',
      severity: 'error',
      from: {
        path: '^(src/domain/|src/services/(reporter|mapper|retry)\\.ts|src/infrastructure/(pi-extension|file-store|http-client|client-config-loader)\\.ts)',
      },
      to: {
        path: '^(src/(index|simulate|config|logger)\\.ts|src/infrastructure/(http-server|index)\\.ts|src/services/(registry|index)\\.ts)$',
      },
    },
    {
      name: 'server-entry-separation',
      comment: 'server 入口不得导入 client 装配/模拟器/采集/传输模块（分离部署契约）',
      severity: 'error',
      from: { path: '^src/index\\\\.ts$' },
      to: {
        path: '^(src/simulate\\.ts|src/infrastructure/(pi-extension|simulator|http-client|client-config-loader|index)\\.ts|src/services/(reporter|mapper|retry|index)\\.ts)$',
      },
    },
  ],
  options: {
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      extensions: ['.ts', '.js'],
    },
  },
};

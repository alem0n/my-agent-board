/**
 * 派生态类型（docs/BOARD.md A1-A4）：纯类型模块。
 *
 * 职责契约：
 * - 只包含派生状态的结构类型，无运行时值、无外部依赖、无导入。
 * - 独立模块以打破 derivation.ts ↔ registry-model.ts 的类型环：
 *   derived-status ← registry-model ← derivation。
 * - 派生的计算逻辑在 derivation.ts；注册表模型在 registry-model.ts。
 */
export {};
//# sourceMappingURL=derived-status.js.map
/**
 * domain 层：领域模型与核心规则。
 *
 * 高内聚低耦合契约：
 * - 本层不得导入 services / infrastructure。
 * - 本层不得访问任何外部 IO。
 * - 本层被 services 层依赖，但不依赖任何上层。
 *
 * 状态注册表（STATE_REGISTRY）与逐状态契约是 client-server 协议的唯一信源。
 */
export {
  STATE_REGISTRY,
  STATE_IDS,
  getContract,
  isKnownState,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from './contracts.js';
export type {
  StateContract,
  FieldSpec,
  FieldType,
  AgentIdentityFields,
  ReportEnvelope,
  BatchRequest,
  RejectedReport,
  ReportResponse,
} from './contracts.js';
export { validateEnvelope, validatePayload, validateField } from './validation.js';
export type { ValidationResult, FieldError, EnvelopeValidationOptions } from './validation.js';
export { resolveIdentity } from './identity.js';
export type { ResolvedIdentity, ResolveResult, PersistedIdentity } from './identity.js';
export { parseClientConfig, logConfigIssues, DEFAULT_CLIENT_CONFIG } from './client-config.js';
export type { ClientConfig, RetryConfig, ConfigIssue } from './client-config.js';
export { ERROR_CODES, ProtocolError, BatchTooLargeError } from './errors.js';
export type { ErrorCode } from './errors.js';
export type { BoardLogger } from './logging.js';
export { silentLogger } from './logging.js';
export type {
  PiEnvironmentSnapshot,
  PiEnvironmentProvider,
  PiStateSource,
  ExtensionMode,
  ContextUsageSnapshot,
} from './pi-env.js';
export type {
  HistoryEntry,
  AgentRecord,
  RegistrySnapshot,
  AgentSummary,
  HistoryQuery,
  HistoryResult,
} from './registry-model.js';
export type { RegistryStore } from './registry-model.js';
export type { Transport, IdentityStore } from './ports.js';

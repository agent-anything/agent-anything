export {
  HELARC_PRODUCT_ID,
  helarcProduct,
  type HelarcProductDescriptor,
} from "./HelarcProduct.js";
export type {
  CreateHelarcTaskInput,
  CreateHelarcTaskResult,
  HelarcTaskInput,
  HelarcTaskInputError,
  HelarcTaskInputErrorCode,
  TrustedHelarcWorkspaceSelection,
} from "./task/index.js";
export {
  createHelarcTask,
  createTrustedHelarcWorkspaceScope,
  DEFAULT_HELARC_TASK_PROMPT_MAX_LENGTH,
  HELARC_TASK_KIND,
  HELARC_WORKSPACE_ROOT_NAME,
} from "./task/index.js";
export type {
  CreateHelarcTaskTemplateInput,
  CreateHelarcTaskTemplateResult,
  HelarcTaskTemplate,
  HelarcTaskTemplateCategory,
  HelarcTaskTemplateError,
  HelarcTaskTemplateErrorCode,
  SelectHelarcTaskTemplateResult,
} from "./task-template/index.js";
export {
  createBuiltInHelarcTaskTemplates,
  createHelarcTaskTemplate,
  renderHelarcTaskTemplatePrompt,
  selectHelarcTaskTemplate,
} from "./task-template/index.js";
export type {
  HelarcAgentOutput,
  HelarcChangeIntent,
  HelarcChangeOperationKind,
  HelarcProviderStructuredOutput,
} from "./planner/index.js";
export {
  buildHelarcProviderRequest,
  HELARC_PLANNER_CAPABILITY,
  HELARC_PLANNER_OUTPUT_MAX_LENGTH,
  HelarcPlannerParseError,
  parseHelarcProviderResponse,
  parseStructuredOutput,
} from "./planner/index.js";
export type {
  CreateHelarcProviderProfileInput,
  CreateHelarcProviderProfileResult,
  HelarcProviderCredentialStatus,
  HelarcProviderKind,
  HelarcProviderProfile,
  HelarcProviderProfileError,
  HelarcProviderProfileErrorCode,
  SelectHelarcProviderProfileResult,
} from "./provider-profile/index.js";
export {
  createHelarcProviderProfile,
  selectHelarcProviderProfile,
} from "./provider-profile/index.js";
export type {
  CreateHelarcSessionHistoryRecordInput,
  CreateHelarcSessionHistoryRecordResult,
  HelarcSessionHistoryPatchDecision,
  HelarcSessionHistoryPatchSummary,
  HelarcSessionHistoryProviderRef,
  HelarcSessionHistoryRecord,
  HelarcSessionHistoryRecordError,
  HelarcSessionHistoryRecordErrorCode,
  HelarcSessionHistoryStatus,
  HelarcSessionHistoryWorkspaceRef,
} from "./session-history/index.js";
export {
  createHelarcSessionHistoryRecord,
} from "./session-history/index.js";
export type {
  CreateHelarcRunInput,
  CreateHelarcRunInputResult,
  CreateHelarcRunTerminalSummaryInput,
  CreateHelarcRunTerminalSummaryResult,
  HelarcRunContractError,
  HelarcRunContractErrorCode,
  HelarcRunEventKind,
  HelarcRunEventSeverity,
  HelarcRunEventViewModel,
  HelarcRunInput,
  HelarcRunPermissionPreset,
  HelarcRunPermissionPrompt,
  HelarcRunPermissionRiskLevel,
  HelarcRunProviderRef,
  HelarcRunSnapshot,
  HelarcRunStatus,
  HelarcRunTerminalErrorSummary,
  HelarcRunTerminalStatus,
  HelarcRunTerminalSummary,
  HelarcRunWorkspaceRef,
} from "./run/index.js";
export {
  createHelarcRunInput,
  createHelarcRunTerminalSummary,
  createIdleHelarcRunSnapshot,
  mapRuntimeEventToHelarcRunEvent,
} from "./run/index.js";
export type {
  CreateHelarcWorkspaceProfileInput,
  CreateHelarcWorkspaceProfileResult,
  HelarcWorkspaceProfile,
  HelarcWorkspaceProfileError,
  HelarcWorkspaceProfileErrorCode,
  HelarcWorkspaceTrustState,
  SelectHelarcWorkspaceProfileResult,
} from "./workspace-profile/index.js";
export {
  createHelarcWorkspaceProfile,
  selectHelarcWorkspaceProfile,
} from "./workspace-profile/index.js";
export type {
  HelarcActivityItem,
  HelarcPatchReviewBridge,
  HelarcPatchReviewDecision,
  HelarcPatchReviewViewModel,
  HelarcPatchStatus,
  HelarcSessionOutput,
  HelarcSessionResult,
  HelarcSessionStatus,
  RunHelarcReadOnlySessionInput,
  RunHelarcSessionInput,
} from "./session/index.js";
export {
  createHelarcToolRegistry,
  createHelarcReadOnlyToolRegistry,
  mapRuntimeEventToHelarcActivity,
  runHelarcReadOnlySession,
  runHelarcSession,
} from "./session/index.js";

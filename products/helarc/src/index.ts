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

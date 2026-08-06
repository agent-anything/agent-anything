import { describe, expect, it } from "vitest";
import * as commandApi from "./command/index.js";
import * as controllerApi from "./controller/index.js";
import * as fileActionsApi from "./file-actions/index.js";
import * as filesystemApi from "./filesystem/index.js";
import * as observabilityApi from "./observability/index.js";
import * as patchApi from "./patch/index.js";
import * as promptApi from "./prompt/index.js";
import * as taskApi from "./task/index.js";
import * as taskTemplatesApi from "./task-templates/index.js";
import * as toolsApi from "./tools/index.js";
import * as workspaceApi from "./workspace/index.js";

describe("Code Agent public API", () => {
  it("exposes focused behavior surfaces without a root barrel", () => {
    expect(Object.keys(taskApi).sort()).toEqual([
      "DEFAULT_HELARC_TASK_PROMPT_MAX_LENGTH",
      "HELARC_TASK_KIND",
      "createHelarcTask",
    ]);
    expect(Object.keys(controllerApi).sort()).toEqual([
      "HELARC_CONTROLLER_ACTIONS",
      "HELARC_CONTROLLER_CAPABILITY",
      "HELARC_CONTROLLER_OUTPUT_MAX_LENGTH",
      "HelarcControllerParseError",
      "buildHelarcActionDecisionRulesText",
      "buildHelarcActionProtocolText",
      "buildHelarcProviderRequest",
      "createHelarcActionContract",
      "createHelarcContextProjector",
      "parseHelarcProviderResponse",
      "parseStructuredOutput",
      "runHelarcProtocolEvalFixture",
    ]);
    expect(Object.keys(promptApi).sort()).toEqual([
      "HELARC_ACTION_CONTRACT_VERSION",
      "HELARC_PROMPT_ARCHITECTURE_VERSION",
      "HELARC_TOOL_CATALOG_VERSION",
      "buildHelarcPromptAssembly",
    ]);
    expect(Object.keys(toolsApi).sort()).toEqual([
      "HELARC_TOOL_CATALOG_METADATA_KEY",
      "buildHelarcToolCatalogText",
      "createDefaultHelarcToolCatalog",
      "createHelarcToolCatalogFromDescriptors",
      "createHelarcToolCatalogMetadata",
      "readHelarcToolCatalog",
    ]);
    expect(Object.keys(taskTemplatesApi).sort()).toEqual([
      "createBuiltInHelarcTaskTemplates",
      "createHelarcTaskTemplate",
      "renderHelarcTaskTemplatePrompt",
      "selectHelarcTaskTemplate",
    ]);
  });

  it("keeps code-work capability values on their semantic paths", () => {
    expect(Object.keys(workspaceApi).sort()).toEqual(["resolveWorkspacePath"]);
    expect(Object.keys(filesystemApi).sort()).toEqual([
      "createCodeAgentCanonicalWorkspaceRoots",
      "defaultCodeAgentFileLimits",
    ]);
    expect(Object.keys(fileActionsApi).sort()).toEqual([
      "CODE_AGENT_CREATE_FILE_ACTION",
      "CODE_AGENT_DELETE_FILE_ACTION",
      "CODE_AGENT_LIST_FILES_ACTION",
      "CODE_AGENT_READ_FILE_ACTION",
      "CODE_AGENT_SEARCH_FILES_ACTION",
      "CODE_AGENT_UPDATE_FILE_ACTION",
      "createAcceptedPatchFileAction",
      "createCodeAgentFileActionCapability",
    ]);
    expect(Object.keys(commandApi).sort()).toEqual([
      "CODE_AGENT_RUN_COMMAND_ACTION",
      "createCodeAgentCommandActionCapability",
      "defaultCodeAgentCommandLimits",
    ]);
    expect(Object.keys(patchApi).sort()).toEqual([
      "HelarcPatchActionController",
      "PatchWorkflowError",
      "acceptPatch",
      "createPatchProposal",
      "defaultPatchWorkflowLimits",
      "materializePatchReview",
      "rejectPatch",
    ]);
    expect(Object.keys(observabilityApi).sort()).toEqual([
      "HelarcTracingController",
      "projectHelarcControllerTraceForEvent",
    ]);
  });
});

import { describe, expect, it } from "vitest";
import * as agentApi from "./agent/index.js";
import * as compositionApi from "./composition/index.js";
import * as configurationApi from "./configuration/index.js";
import * as controllerApi from "./controller/index.js";
import * as helarcApi from "./index.js";
import * as runApi from "./run/index.js";
import * as toolsApi from "./tools/index.js";
import * as workContextApi from "./work-context/index.js";

describe("Helarc public API", () => {
  it("keeps the root limited to Product identity", () => {
    expect(Object.keys(helarcApi).sort()).toEqual(["HELARC_PRODUCT_ID", "helarcProduct"]);
  });
  it("exposes focused Product configuration, work-context, run and composition values", () => {
    expect(Object.keys(agentApi).sort()).toEqual(["createHelarcAgent", "createHelarcDelegatedWorkerAgent"]);
    expect(Object.keys(configurationApi).sort()).toEqual([
      "HELARC_COMPACTION_PRESERVATION",
      "contextSettingsSnapshot", "createDefaultHelarcContextSettings", "createDefaultHelarcInstructionSettings", "createHelarcProviderProfile", "createHelarcWorkspaceProfile",
      "defaultHelarcInRequestCompactionPolicy", "matchHelarcContextObservations", "matchHelarcNativeContextObservations",
      "resolveHelarcPermissionPreset", "selectHelarcProviderProfile", "selectHelarcWorkspaceProfile",
      "snapshotHelarcContextSettings", "snapshotHelarcInRequestCompactionPolicy", "snapshotHelarcInstructionSettings", "snapshotHelarcProject", "snapshotHelarcProviderModelSettings",
    ]);
    expect(Object.keys(workContextApi).sort()).toEqual([
      "applyHelarcRunProjectionCommit", "applyHelarcRunStartCommit", "applyHelarcRunTerminalCommit",
      "createHelarcArtifact", "createHelarcMessage", "createHelarcPersistedRun", "createHelarcThread",
      "deriveHelarcPersistedRunStatus", "normalizeHelarcThreadAggregate", "normalizeHelarcThreadRecord",
      "projectHelarcWorkspaceSelectionIdentity", "snapshotHelarcCollaborationRecord", "snapshotHelarcReviewRecord",
    ]);
    expect(Object.keys(runApi).sort()).toEqual([
      "createHelarcNativePresentationReader", "createHelarcProductRunProjection", "createHelarcRunInput", "createHelarcRunProjection",
      "deriveHelarcRunDisplayProjection", "helarcNativePresentationId", "helarcNativeResponseGroupId", "helarcSubtaskName", "reduceHelarcProductRunProjection", "reduceHelarcRunProjection",
    ]);
    expect(Object.keys(compositionApi).sort()).toEqual([
      "HelarcProviderCompatibilityError", "assertHelarcProviderCompatibility", "createHelarcActionComposition",
      "createHelarcDeepSeekStructuredPurposes", "createHelarcDeepSeekTaskExecution", "createHelarcNativeProductComposition",
      "createHelarcOllamaStructuredPurposes", "createHelarcOllamaTaskExecution", "createHelarcProductComposition",
      "createHelarcResponsesStructuredPurposes", "createHelarcResponsesTaskExecution", "createHelarcTaskModelBinding", "mapRuntimeEventToHelarcActivity", "projectHelarcProductResult",
    ]);
    for (const name of ["buildHelarcProviderRequest", "parseHelarcProviderResponse", "createHelarcModelCallableCatalog"]) expect(controllerApi).toHaveProperty(name);
    expect(controllerApi).not.toHaveProperty("parseHelarcModelDecision");
    expect(controllerApi).not.toHaveProperty("createHelarcActionContract");
    for (const name of ["createHelarcBaselineToolContracts", "HELARC_BASELINE_TOOL_CONTRACTS", "createHelarcToolGuidanceSource", "resolveHelarcToolGuidance", "admitHelarcSelectedTools"]) expect(toolsApi).toHaveProperty(name);
  });
  it("does not expose execution or model evaluation from the Product root", () => {
    for (const name of ["buildHelarcPromptAssembly", "createHelarcTask", "RunExecutionCoordinator", "ActionEnforcementPipeline", "runHelarcQualificationTrial"]) expect(helarcApi).not.toHaveProperty(name);
  });
});

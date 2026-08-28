import { describe, expect, it } from "vitest";
import * as agentApi from "./agent/index.js";
import * as compositionApi from "./composition/index.js";
import * as configurationApi from "./configuration/index.js";
import * as controllerApi from "./controller/index.js";
import * as helarcApi from "./index.js";
import * as modelQualificationApi from "./model-qualification/index.js";
import * as runApi from "./run/index.js";
import * as toolsApi from "./tools/index.js";
import * as workContextApi from "./work-context/index.js";

describe("Helarc public API", () => {
  it("keeps the root limited to Product identity", () => {
    expect(Object.keys(helarcApi).sort()).toEqual([
      "HELARC_PRODUCT_ID",
      "helarcProduct",
    ]);
  });

  it("exposes focused Product configuration, work-context, run, and composition values", () => {
    expect(Object.keys(agentApi).sort()).toEqual([
      "createHelarcAgent",
      "createHelarcDelegatedWorkerAgent",
    ]);
    expect(Object.keys(configurationApi).sort()).toEqual([
      "createHelarcProviderProfile",
      "createHelarcWorkspaceProfile",
      "resolveHelarcPermissionPreset",
      "selectHelarcProviderProfile",
      "selectHelarcWorkspaceProfile",
    ]);
    expect(Object.keys(workContextApi).sort()).toEqual([
      "applyHelarcRunProjectionCommit",
      "applyHelarcRunStartCommit",
      "applyHelarcRunTerminalCommit",
      "createHelarcArtifact",
      "createHelarcMessage",
      "createHelarcPersistedRun",
      "createHelarcThread",
      "deriveHelarcPersistedRunStatus",
      "normalizeHelarcThreadAggregate",
      "normalizeHelarcThreadRecord",
      "projectHelarcWorkspaceSelectionIdentity",
      "snapshotHelarcCollaborationRecord",
      "snapshotHelarcReviewRecord",
    ]);
    expect(Object.keys(runApi).sort()).toEqual([
      "createHelarcProductRunProjection",
      "createHelarcRunInput",
      "createHelarcRunProjection",
      "deriveHelarcRunDisplayProjection",
      "reduceHelarcProductRunProjection",
      "reduceHelarcRunProjection",
    ]);
    expect(Object.keys(compositionApi).sort()).toEqual([
      "HELARC_OPERATING_PROFILE_REVISION",
      "HELARC_PRODUCT_REVISION",
      "HelarcModelUseAdmissionError",
      "admitHelarcModelUse",
      "createHelarcActionComposition",
      "createHelarcProductComposition",
      "mapRuntimeEventToHelarcActivity",
      "projectHelarcProductResult",
      "resolveHelarcModelQualification",
      "validateHelarcToolInput",
    ]);
    expect(controllerApi).toHaveProperty("buildHelarcProviderRequest");
    expect(controllerApi).toHaveProperty("parseHelarcProviderResponse");
    expect(controllerApi).toHaveProperty("createHelarcModelCallableCatalog");
    expect(controllerApi).not.toHaveProperty("parseHelarcModelDecision");
    expect(controllerApi).not.toHaveProperty("createHelarcActionContract");
    expect(toolsApi).toHaveProperty("createHelarcBaselineToolContracts");
    expect(toolsApi).toHaveProperty("HELARC_BASELINE_TOOL_CONTRACTS");
    expect(toolsApi).toHaveProperty("createHelarcToolGuidanceSource");
    expect(toolsApi).toHaveProperty("resolveHelarcToolGuidance");
    expect(toolsApi).toHaveProperty("admitHelarcSelectedTools");
    expect(modelQualificationApi).toHaveProperty("createHelarcModelQualificationTarget");
    expect(modelQualificationApi).toHaveProperty("createHelarcModelQualificationDecision");
    expect(compositionApi).toHaveProperty("resolveHelarcModelQualification");
    expect(compositionApi).toHaveProperty("admitHelarcModelUse");
    expect(modelQualificationApi).toHaveProperty("deriveHelarcModelUseDisposition");
  });

  it("does not expose Code Agent or Host execution values from the Product root", () => {
    expect(helarcApi).not.toHaveProperty("buildHelarcPromptAssembly");
    expect(helarcApi).not.toHaveProperty("createHelarcTask");
    expect(helarcApi).not.toHaveProperty("Runner");
    expect(helarcApi).not.toHaveProperty("ActionEnforcementPipeline");
  });
});

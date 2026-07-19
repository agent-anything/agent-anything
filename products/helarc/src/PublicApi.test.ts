import { describe, expect, it } from "vitest";
import * as helarcApi from "./index.js";

describe("Helarc public API", () => {
  it("exports only reviewed Host-facing product values", () => {
    expect(Object.keys(helarcApi).sort()).toEqual([
      "DEFAULT_HELARC_TASK_PROMPT_MAX_LENGTH",
      "HELARC_PRODUCT_ID",
      "HELARC_TASK_KIND",
      "HELARC_WORKSPACE_ROOT_NAME",
      "applyHelarcRunProgressCommit",
      "applyHelarcRunStartCommit",
      "applyHelarcRunTerminalCommit",
      "createBuiltInHelarcTaskTemplates",
      "createHelarcActionComposition",
      "createHelarcArtifact",
      "createHelarcConversation",
      "createHelarcMessage",
      "createHelarcPersistedRun",
      "createHelarcProductComposition",
      "createHelarcProductRunProjection",
      "createHelarcProviderProfile",
      "createHelarcRunInput",
      "createHelarcRunProjection",
      "createHelarcTask",
      "createHelarcTaskTemplate",
      "createHelarcThread",
      "createHelarcWorkspaceProfile",
      "createTrustedHelarcWorkspaceScope",
      "deriveHelarcPersistedRunStatus",
      "deriveHelarcRunDisplayProjection",
      "helarcProduct",
      "normalizeHelarcThreadAggregate",
      "normalizeHelarcThreadRecord",
      "reduceHelarcProductRunProjection",
      "reduceHelarcRunProjection",
      "renderHelarcTaskTemplatePrompt",
      "resolveHelarcPermissionPreset",
      "selectHelarcProviderProfile",
      "selectHelarcTaskTemplate",
      "selectHelarcWorkspaceProfile",
    ]);
  });

  it("does not expose product implementation or platform execution values", () => {
    expect(helarcApi).not.toHaveProperty("buildHelarcPromptAssembly");
    expect(helarcApi).not.toHaveProperty("buildHelarcProviderRequest");
    expect(helarcApi).not.toHaveProperty("parseHelarcProviderResponse");
    expect(helarcApi).not.toHaveProperty("projectHelarcProductResult");
    expect(helarcApi).not.toHaveProperty("mapRuntimeEventToHelarcActivity");
    expect(helarcApi).not.toHaveProperty("Runner");
    expect(helarcApi).not.toHaveProperty("ActionEnforcementPipeline");
    expect(helarcApi).not.toHaveProperty("createSandboxExecutionGateway");
    expect(helarcApi).not.toHaveProperty("createHostRuntime");
  });
});

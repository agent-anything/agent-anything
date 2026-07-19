import type { CodeAgentFileLimits } from "@agent-anything/code-agent";
import type { CodeAgentCommandActionCapability } from "@agent-anything/code-agent/command";
import type { CodeAgentFileActionCapability } from "@agent-anything/code-agent/filesystem";
import type { PatchProposal } from "@agent-anything/code-agent/patch";
import type { WorkspacePathResolution } from "@agent-anything/code-agent/workspace";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as commandApi from "./process/index.js";
import * as filesystemApi from "./filesystem/index.js";
import * as codeAgentApi from "./index.js";
import * as patchApi from "./patch/index.js";
import * as workspaceApi from "./workspace/index.js";

describe("Code Agent public API", () => {
  it("exposes the reviewed aggregate and focused capability values", () => {
    expect(Object.keys(codeAgentApi).sort()).toEqual([
      "CODE_AGENT_CREATE_FILE_ACTION",
      "CODE_AGENT_DELETE_FILE_ACTION",
      "CODE_AGENT_LIST_FILES_ACTION",
      "CODE_AGENT_READ_FILE_ACTION",
      "CODE_AGENT_RUN_COMMAND_ACTION",
      "CODE_AGENT_SEARCH_FILES_ACTION",
      "CODE_AGENT_UPDATE_FILE_ACTION",
      "PatchWorkflowError",
      "acceptPatch",
      "createAcceptedPatchFileAction",
      "createCodeAgentCanonicalWorkspaceRoots",
      "createCodeAgentCommandActionCapability",
      "createCodeAgentFileActionCapability",
      "createPatchProposal",
      "defaultCodeAgentCommandLimits",
      "defaultCodeAgentFileLimits",
      "defaultPatchWorkflowLimits",
      "materializePatchReview",
      "rejectPatch",
      "resolveWorkspacePath",
    ]);
    expect(Object.keys(workspaceApi).sort()).toEqual(["resolveWorkspacePath"]);
    expect(Object.keys(filesystemApi).sort()).toEqual([
      "CODE_AGENT_CREATE_FILE_ACTION",
      "CODE_AGENT_DELETE_FILE_ACTION",
      "CODE_AGENT_LIST_FILES_ACTION",
      "CODE_AGENT_READ_FILE_ACTION",
      "CODE_AGENT_SEARCH_FILES_ACTION",
      "CODE_AGENT_UPDATE_FILE_ACTION",
      "createAcceptedPatchFileAction",
      "createCodeAgentCanonicalWorkspaceRoots",
      "createCodeAgentFileActionCapability",
      "defaultCodeAgentFileLimits",
    ]);
    expect(Object.keys(commandApi).sort()).toEqual([
      "CODE_AGENT_RUN_COMMAND_ACTION",
      "createCodeAgentCommandActionCapability",
      "defaultCodeAgentCommandLimits",
    ]);
    expect(Object.keys(patchApi).sort()).toEqual([
      "PatchWorkflowError",
      "acceptPatch",
      "createPatchProposal",
      "defaultPatchWorkflowLimits",
      "materializePatchReview",
      "rejectPatch",
    ]);
  });

  it("resolves focused types without exposing an alternate execution path", () => {
    expectTypeOf<CodeAgentFileLimits>().toBeObject();
    expectTypeOf<WorkspacePathResolution>().toBeObject();
    expectTypeOf<CodeAgentFileActionCapability>().toBeObject();
    expectTypeOf<CodeAgentCommandActionCapability>().toBeObject();
    expectTypeOf<PatchProposal>().toBeObject();
    expect(codeAgentApi).not.toHaveProperty("Runner");
    expect(codeAgentApi).not.toHaveProperty("ActionEnforcementPipeline");
    expect(codeAgentApi).not.toHaveProperty("createSandboxExecutionGateway");
    expect(codeAgentApi).not.toHaveProperty("createHostRuntime");
  });
});

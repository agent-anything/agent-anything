import { describe, expect, it } from "vitest";
import {
  createHelarcRunInput,
} from "./HelarcRun.js";

describe("HelarcRun", () => {
  it("creates normalized run input", () => {
    const result = createHelarcRunInput({
      runId: " run-1 ",
      taskText: " Inspect workspace ",
      workspaceProfileId: " workspace-1 ",
      providerProfileId: " provider-1 ",
      taskTemplateId: " template-1 ",
      permissionPreset: "full_access",
      createdAt: "2026-07-04T00:00:00.000Z",
      metadata: { source: "test" },
    });

    expect(result).toEqual({
      ok: true,
      input: {
        runId: "run-1",
        taskText: "Inspect workspace",
        workspaceProfileId: "workspace-1",
        providerProfileId: "provider-1",
        taskTemplateId: "template-1",
        permissionPreset: "full_access",
        createdAt: "2026-07-04T00:00:00.000Z",
        metadata: { source: "test" },
      },
    });
  });

  it("defaults optional run input fields", () => {
    const result = createHelarcRunInput({
      runId: "run-1",
      taskText: "Inspect workspace",
      workspaceProfileId: "workspace-1",
      providerProfileId: "provider-1",
      createdAt: "2026-07-04T00:00:00.000Z",
    });

    expect(result).toMatchObject({
      ok: true,
      input: {
        taskTemplateId: null,
        permissionPreset: "ask_for_approval",
        metadata: {},
      },
    });
  });

  it("rejects invalid run input", () => {
    expect(createHelarcRunInput({
      ...runInput(),
      taskText: " ",
    })).toMatchObject({
      ok: false,
      error: { code: "run_task_text_required" },
    });

    expect(createHelarcRunInput({
      ...runInput(),
      workspaceProfileId: " ",
    })).toMatchObject({
      ok: false,
      error: { code: "run_workspace_profile_id_required" },
    });

    expect(createHelarcRunInput({
      ...runInput(),
      permissionPreset: "always" as never,
    })).toMatchObject({
      ok: false,
      error: { code: "run_permission_preset_invalid" },
    });
  });

});

function runInput() {
  return {
    runId: "run-1",
    taskText: "Inspect workspace",
    workspaceProfileId: "workspace-1",
    providerProfileId: "provider-1",
    permissionPreset: "ask_for_approval" as const,
    createdAt: "2026-07-04T00:00:00.000Z",
  };
}

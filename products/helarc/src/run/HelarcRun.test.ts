import { describe, expect, it } from "vitest";
import {
  createHelarcRunInput,
  createHelarcRunTerminalSummary,
  createIdleHelarcRunSnapshot,
} from "./HelarcRun.js";

describe("HelarcRun", () => {
  it("creates normalized run input", () => {
    const result = createHelarcRunInput({
      runId: " run-1 ",
      taskText: " Inspect workspace ",
      workspaceProfileId: " workspace-1 ",
      providerProfileId: " provider-1 ",
      taskTemplateId: " template-1 ",
      permissionPreset: "trusted",
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
        permissionPreset: "trusted",
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
        permissionPreset: "ask",
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

  it("creates terminal summaries for terminal states", () => {
    const result = createHelarcRunTerminalSummary({
      status: "failed",
      runtimeStatus: "failed",
      runtimeCode: " provider_failed ",
      safeOutput: { summary: "Provider failed." },
      errorSummary: [{ code: " provider_failed ", message: " Provider failed. " }],
      startedAt: "2026-07-04T00:00:00.000Z",
      completedAt: "2026-07-04T00:00:10.000Z",
      eventCount: 3,
    });

    expect(result).toEqual({
      ok: true,
      terminal: {
        status: "failed",
        runtimeStatus: "failed",
        runtimeCode: "provider_failed",
        safeOutput: { summary: "Provider failed." },
        errorSummary: [{ code: "provider_failed", message: "Provider failed." }],
        startedAt: "2026-07-04T00:00:00.000Z",
        completedAt: "2026-07-04T00:00:10.000Z",
        eventCount: 3,
      },
    });
  });

  it("rejects non-terminal or malformed terminal summaries", () => {
    expect(createHelarcRunTerminalSummary({
      ...terminalInput(),
      status: "running" as never,
    })).toMatchObject({
      ok: false,
      error: { code: "run_terminal_status_invalid" },
    });

    expect(createHelarcRunTerminalSummary({
      ...terminalInput(),
      eventCount: -1,
    })).toMatchObject({
      ok: false,
      error: { code: "run_terminal_event_count_invalid" },
    });

    expect(createHelarcRunTerminalSummary({
      ...terminalInput(),
      errorSummary: [{ code: "", message: "Missing code." }],
    })).toMatchObject({
      ok: false,
      error: { code: "run_terminal_error_summary_invalid" },
    });
  });

  it("creates renderer-safe idle snapshots", () => {
    expect(createIdleHelarcRunSnapshot({ product: "helarc" })).toEqual({
      runId: "",
      status: "idle",
      task: {
        text: "",
        templateId: null,
      },
      workspace: null,
      provider: null,
      events: [],
      pendingPermission: null,
      terminal: null,
      startedAt: null,
      metadata: { product: "helarc" },
    });
  });
});

function runInput() {
  return {
    runId: "run-1",
    taskText: "Inspect workspace",
    workspaceProfileId: "workspace-1",
    providerProfileId: "provider-1",
    permissionPreset: "ask" as const,
    createdAt: "2026-07-04T00:00:00.000Z",
  };
}

function terminalInput() {
  return {
    status: "completed" as const,
    runtimeStatus: "succeeded" as const,
    runtimeCode: null,
    safeOutput: { summary: "Done." },
    errorSummary: [],
    startedAt: "2026-07-04T00:00:00.000Z",
    completedAt: "2026-07-04T00:00:10.000Z",
    eventCount: 1,
  };
}

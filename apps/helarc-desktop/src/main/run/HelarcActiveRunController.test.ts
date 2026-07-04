import { describe, expect, it } from "vitest";
import { HelarcActiveRunController } from "./HelarcActiveRunController.js";

describe("HelarcActiveRunController", () => {
  it("starts one renderer-safe active run", () => {
    const controller = new HelarcActiveRunController();

    const result = controller.startRun(activeRunInput());

    expect(result).toEqual({
      ok: true,
      snapshot: {
        runId: "run-1",
        status: "starting",
        task: {
          text: "Inspect workspace",
          templateId: "inspect-code",
        },
        workspace: {
          profileId: "workspace-1",
          displayName: "agent-anything",
          path: "D:\\projects\\agent-anything",
        },
        provider: {
          profileId: "provider-1",
          providerKind: "openai-compatible",
          displayName: "Provider A",
          endpointLabel: "provider.local",
          model: "model-a",
        },
        events: [],
        pendingPermission: null,
        terminal: null,
        startedAt: "2026-07-04T00:00:00.000Z",
        metadata: { product: "helarc", source: "test" },
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("authorization");
  });

  it("rejects invalid starts before runtime construction", () => {
    const controller = new HelarcActiveRunController();

    expect(controller.startRun({
      ...activeRunInput(),
      workspace: null,
    })).toMatchObject({
      ok: false,
      error: { code: "active_run_workspace_required" },
      snapshot: { status: "idle" },
    });

    expect(controller.startRun({
      ...activeRunInput(),
      provider: null,
    })).toMatchObject({
      ok: false,
      error: { code: "active_run_provider_required" },
      snapshot: { status: "idle" },
    });
  });

  it("enforces one active run at a time", () => {
    const controller = new HelarcActiveRunController();

    expect(controller.startRun(activeRunInput())).toMatchObject({ ok: true });
    expect(controller.startRun({
      ...activeRunInput(),
      run: {
        ...activeRunInput().run,
        runId: "run-2",
      },
    })).toMatchObject({
      ok: false,
      error: { code: "active_run_already_running" },
      snapshot: { runId: "run-1", status: "starting" },
    });
  });

  it("appends events and publishes snapshots", () => {
    const controller = new HelarcActiveRunController();
    const snapshots: string[] = [];
    controller.subscribe((snapshot) => {
      snapshots.push(snapshot.status);
    });

    controller.startRun(activeRunInput());
    controller.markRunning();
    const eventResult = controller.appendEvent({
      id: "event-1",
      sequence: 1,
      timestamp: "2026-07-04T00:00:01.000Z",
      kind: "planning.started",
      title: "Planning started",
      detail: null,
      severity: "info",
      metadata: {},
    });

    expect(eventResult).toMatchObject({
      ok: true,
      snapshot: {
        status: "running",
        events: [
          {
            id: "event-1",
            kind: "planning.started",
            title: "Planning started",
          },
        ],
      },
    });
    expect(snapshots).toEqual(["starting", "running", "running"]);
  });

  it("moves through cancelling and terminal states", () => {
    const controller = new HelarcActiveRunController();
    controller.startRun(activeRunInput());
    controller.markRunning();

    expect(controller.requestCancel()).toMatchObject({
      ok: true,
      snapshot: { status: "cancelling", pendingPermission: null },
    });

    expect(controller.completeRun(terminalSummary("cancelled"))).toMatchObject({
      ok: true,
      snapshot: {
        status: "cancelled",
        terminal: {
          status: "cancelled",
          runtimeStatus: null,
          eventCount: 0,
        },
      },
    });
    expect(controller.appendEvent({
      id: "late-event",
      sequence: 2,
      timestamp: "2026-07-04T00:00:02.000Z",
      kind: "run.cancelled",
      title: "Run cancelled",
      detail: null,
      severity: "info",
      metadata: {},
    })).toMatchObject({
      ok: false,
      error: { code: "active_run_not_running" },
    });
  });

  it("resets to an idle snapshot", () => {
    const controller = new HelarcActiveRunController();
    controller.startRun(activeRunInput());

    expect(controller.reset()).toEqual({
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
      metadata: {},
    });
  });
});

function activeRunInput() {
  return {
    run: {
      runId: "run-1",
      taskText: "Inspect workspace",
      workspaceProfileId: "workspace-1",
      providerProfileId: "provider-1",
      taskTemplateId: "inspect-code",
      permissionPreset: "ask" as const,
      createdAt: "2026-07-04T00:00:00.000Z",
      metadata: { product: "helarc" },
    },
    workspace: {
      profileId: "workspace-1",
      displayName: "agent-anything",
      path: "D:\\projects\\agent-anything",
    },
    provider: {
      profileId: "provider-1",
      providerKind: "openai-compatible" as const,
      displayName: "Provider A",
      endpointLabel: "provider.local",
      model: "model-a",
    },
    metadata: { source: "test" },
  };
}

function terminalSummary(status: "completed" | "failed" | "denied" | "cancelled") {
  return {
    status,
    runtimeStatus: status === "completed" ? "succeeded" as const : null,
    runtimeCode: null,
    safeOutput: null,
    errorSummary: [],
    startedAt: "2026-07-04T00:00:00.000Z",
    completedAt: "2026-07-04T00:00:10.000Z",
    eventCount: 0,
  };
}

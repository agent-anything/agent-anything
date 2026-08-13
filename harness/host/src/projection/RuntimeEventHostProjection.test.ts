import {
  RUNTIME_EVENT_SCHEMA_VERSION,
  type RuntimeEvent,
} from "@agent-anything/observability/events";
import { describe, expect, it } from "vitest";
import { projectRuntimeEventForHost } from "./RuntimeEventHostProjection.js";

describe("Host RuntimeEvent projection", () => {
  it("keeps reusable Controller fields and excludes Product trace vocabulary", () => {
    const event = Object.freeze({
      schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
      id: "event-1",
      runId: "run-1",
      taskId: "task-1",
      sequence: 1,
      name: "controller.finished",
      occurredAt: "2026-08-03T00:00:00.000Z",
      payload: Object.freeze({
        turnId: "turn-1",
        iteration: 1,
        status: "decided",
        code: null,
        decisionKind: "advance",
        controllerAction: "call_tool",
        promptArchitectureVersion: "helarc-prompt-v1",
        actionContractVersion: "helarc-action-v1",
        toolCatalogVersion: "helarc-tool-catalog-v1",
        exposedToolNames: ["codeAgent.readFile"],
        requestedToolName: "codeAgent.readFile",
        patchOperation: "create",
        patchPath: "empty.txt",
        rawPrompt: "secret",
      }),
    }) as unknown as RuntimeEvent;

    const projected = projectRuntimeEventForHost(event);

    expect(projected.payload).toEqual({
      turnId: "turn-1",
      iteration: 1,
      status: "decided",
      code: null,
      decisionKind: "advance",
    });
    expect(projected.payload).not.toHaveProperty("controllerAction");
    expect(projected.payload).not.toHaveProperty("promptArchitectureVersion");
    expect(projected.payload).not.toHaveProperty("requestedToolName");
    expect(projected.payload).not.toHaveProperty("patchOperation");
    expect(projected.payload).not.toHaveProperty("rawPrompt");
    expect(event.payload).toHaveProperty("controllerAction", "call_tool");
    expect(Object.isFrozen(projected)).toBe(true);
    expect(Object.isFrozen(projected.payload)).toBe(true);
  });
});

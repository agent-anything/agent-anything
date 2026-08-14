import type { RunObservation } from "@agent-anything/agent-runtime/run";
import {
  snapshotContextProjection,
  type Context,
  type ContextProjectionRequest,
} from "@agent-anything/context/context";
import { describe, expect, it } from "vitest";
import { createHelarcContextProjector } from "./HelarcContextProjector.js";

describe("Helarc Context projector", () => {
  it("selects a bounded window and redacts model-facing Tool output", () => {
    const context = createContext({
      apiToken: "secret-value",
      nested: { password: "also-secret", value: "visible" },
    });
    const request = createRequest();
    const projection = snapshotContextProjection({
      projection: createHelarcContextProjector().project({ context, request }),
      request,
    });

    expect(projection.messages).toEqual([expect.objectContaining({
      id: "message-2",
      content: "latest",
      metadata: {},
    })]);
    expect(projection.metadata).toEqual({});
    expect(projection.observations[0]?.metadata).toEqual({
      actionName: "codeAgent.readFile",
    });
    expect(projection.observations[0]).toMatchObject({
      kind: "tool_result",
      payload: {
        kind: "operation",
        result: {
        output: {
          apiToken: "[REDACTED]",
          nested: { password: "[REDACTED]", value: "visible" },
        },
        },
      },
    });
    expect(context.observations[0]?.metadata).toHaveProperty(
      "credential",
      "must-not-project",
    );
  });

  it("replaces oversized Tool output with an explicit truncation summary", () => {
    const context = createContext({ content: "x".repeat(10_000) });
    const request = createRequest({ maxObservationBytes: 1_500 });
    const projection = snapshotContextProjection({
      projection: createHelarcContextProjector().project({ context, request }),
      request,
    });

    expect(projection.observations[0]).toMatchObject({
      kind: "tool_result",
      payload: {
        kind: "operation",
        result: {
        output: {
          truncated: true,
          summary: expect.stringContaining("projection limit"),
        },
        },
      },
    });
  });
});

function createContext(output: unknown): Context<RunObservation> {
  return {
    messages: [
      { id: "message-1", role: "user", content: "older", metadata: {} },
      { id: "message-2", role: "assistant", content: "latest", metadata: {} },
    ],
    observations: [{
      id: "observation-1",
      runId: "run-1",
      actionId: "action-1",
      kind: "tool_result",
      owner: "code-agent",
      runAction: { run: { id: "run-1" }, id: "action-1", sequence: 1 },
      lowerRefs: [],
      payload: {
        kind: "operation",
        result: {
        ref: {
          invocation: {
            id: "operation-invocation-1",
            operation: {
              operation: { namespace: "code-agent", name: "read-file" },
              revision: "1",
            },
          },
          id: "operation-result-1",
        },
        binding: {
          operation: {
            operation: { namespace: "code-agent", name: "read-file" },
            revision: "1",
          },
          revision: "1",
        },
        semanticOwner: "code-agent",
        status: "succeeded",
        output,
        failure: null,
        startedAt: "2026-07-13T00:00:00.000Z",
        finishedAt: "2026-07-13T00:00:01.000Z",
        lowerRefs: [],
        metadata: { credential: "must-not-project" },
        },
        toolResult: null,
      },
      createdAt: "2026-07-13T00:00:01.000Z",
      metadata: {
        actionName: "codeAgent.readFile",
        credential: "must-not-project",
      },
    }],
    evidenceRefs: ["evidence-1"],
    metadata: { credential: "must-not-project" },
  };
}

function createRequest(
  limits: Partial<ContextProjectionRequest["limits"]> = {},
): ContextProjectionRequest {
  return {
    runId: "run-1",
    controllerIteration: 2,
    purpose: "model",
    limits: {
      maxMessages: 1,
      maxMessageLength: 1_000,
      maxObservations: 10,
      maxObservationBytes: 10_000,
      maxEvidenceRefs: 10,
      maxMetadataEntries: 1,
      ...limits,
    },
  };
}

import { describe, expect, it } from "vitest";
import type { ContextContribution } from "../contribution/ContextContribution.js";
import { ContextContractError } from "../contract/ContextContract.js";
import {
  createEmptyActiveContext,
  snapshotActiveContext,
} from "./ActiveContext.js";
import { snapshotContextTransition } from "./ContextTransition.js";

describe("Active Context and Transition contracts", () => {
  it("creates an immutable version-zero Active Context", () => {
    const context = createEmptyActiveContext({
      id: "context-1",
      runId: "run-1",
      createdAt: "2026-08-14T00:00:00.000Z",
    });

    expect(context.ref).toEqual({ id: "context-1", runId: "run-1", version: 0 });
    expect(context.previous).toBeNull();
    expect(context.appliedTransitionId).toBeNull();
    expect(Object.isFrozen(context.items)).toBe(true);
  });

  it("requires exact previous-version lineage", () => {
    expect(() => snapshotActiveContext({
      ref: { id: "context-1", runId: "run-1", version: 2 },
      previous: { id: "context-1", runId: "run-1", version: 0 },
      appliedTransitionId: "transition-2",
      items: [],
      createdAt: "2026-08-14T00:00:02.000Z",
    }, { maxContributionPayloadBytes: 64 })).toThrow(ContextContractError);
  });

  it("snapshots an attributed add Transition without applying it", () => {
    const transition = snapshotContextTransition({
      id: "transition-1",
      base: { id: "context-1", runId: "run-1", version: 0 },
      proposer: { owner: "runner", kind: "tool_result", id: "result-1" },
      cause: { kind: "action_completed", id: "action-1" },
      correlationId: "attempt-1",
      operations: [{
        kind: "add",
        item: { id: "item-1" },
        contribution: contribution(),
      }],
      createdAt: "2026-08-14T00:00:01.000Z",
    }, { maxContributionPayloadBytes: 64 });

    expect(transition.operations[0]?.kind).toBe("add");
    expect(transition.proposer.owner).toBe("runner");
    expect(Object.isFrozen(transition.operations)).toBe(true);
  });

  it("rejects duplicate item operations and cross-Run Contributions", () => {
    const base = {
      id: "transition-1",
      base: { id: "context-1", runId: "run-1", version: 0 },
      proposer: { owner: "runner", kind: "tool_result", id: "result-1" },
      cause: { kind: "action_completed", id: "action-1" },
      correlationId: null,
      createdAt: "2026-08-14T00:00:01.000Z",
    } as const;
    expect(() => snapshotContextTransition({
      ...base,
      operations: [
        { kind: "add", item: { id: "item-1" }, contribution: contribution() },
        { kind: "add", item: { id: "item-1" }, contribution: contribution("contribution-2") },
      ],
    }, { maxContributionPayloadBytes: 64 })).toThrow(ContextContractError);

    expect(() => snapshotContextTransition({
      ...base,
      operations: [{
        kind: "add",
        item: { id: "item-2" },
        contribution: { ...contribution(), scope: { runId: "run-2", ownerScope: null } },
      }],
    }, { maxContributionPayloadBytes: 64 })).toThrow(ContextContractError);
  });
});

function contribution(id = "contribution-1"): ContextContribution {
  return {
    ref: { id, revision: "1" },
    source: {
      owner: "tool:workspace.read",
      kind: "tool_result",
      id: "result-1",
      revision: "1",
      observedAt: "2026-08-14T00:00:00.000Z",
    },
    payload: { kind: "text", text: "hello" },
    scope: { runId: "run-1", ownerScope: null },
    disclosure: { sensitivity: "internal", audiences: ["provider:primary"] },
    handling: {
      retention: "history",
      replacementKey: null,
      instructionRole: "data",
      necessity: "optional",
      precedence: 10,
      allowedTransformations: [],
    },
    provenance: [{ owner: "tool:workspace.read", kind: "tool_result", id: "result-1", revision: "1" }],
    createdAt: "2026-08-14T00:00:00.000Z",
    accounting: { unit: "bytes", payloadBytes: 5 },
  };
}

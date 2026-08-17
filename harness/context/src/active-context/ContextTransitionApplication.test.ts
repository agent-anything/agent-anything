import { describe, expect, it } from "vitest";
import { ContextContractError } from "../contract/ContextContract.js";
import type { ContextContribution } from "../contribution/ContextContribution.js";
import { measureContextPayload } from "../contribution/ContextContribution.js";
import { createEmptyActiveContext } from "./ActiveContext.js";
import type { ContextAdmissionProfile } from "./ContextAdmission.js";
import { deriveContextRefreshOperation } from "./ContextRefresh.js";
import { applyContextTransition } from "./ContextTransitionApplication.js";

describe("ContextTransition application", () => {
  it("applies ordered operations as one immutable version", () => {
    const initial = emptyContext();
    const first = contribution("current-1", "1", "current", "workspace", "first");
    const history = contribution("history-1", "1", "history", null, "history");
    const added = apply(initial, "transition-1", [
      { kind: "add", item: { id: "item-current" }, contribution: first },
      { kind: "add", item: { id: "item-history" }, contribution: history },
    ]);
    expect(added.ref.version).toBe(1);
    expect(added.previous).toEqual(initial.ref);
    expect(added.items).toHaveLength(2);
    expect(initial.items).toHaveLength(0);

    const replacement = contribution("current-1", "2", "current", "workspace", "second");
    const next = apply(added, "transition-2", [
      { kind: "replace", item: { id: "item-current" }, expectedContribution: first.ref, contribution: replacement },
      { kind: "invalidate", item: { id: "item-history" }, expectedContribution: history.ref, reason: "superseded" },
    ]);
    expect(next.ref.version).toBe(2);
    expect("contribution" in next.items[0]! && next.items[0].contribution.ref.revision).toBe("2");
    expect("contribution" in next.items[1]! && next.items[1].lifecycle.kind).toBe("invalidated");
    expect(Object.isFrozen(next)).toBe(true);
  });

  it("rejects a stale base without changing current state", () => {
    const initial = emptyContext();
    const before = JSON.stringify(initial);
    expectFailure(() => applyContextTransition({
      context: initial,
      transition: transition({ ...initial.ref, version: 1 }, "stale", [{
        kind: "add",
        item: { id: "item-1" },
        contribution: contribution("history-1", "1", "history", null, "value"),
      }]),
      admission: profile(),
      maxContributionPayloadBytes: 1_024,
    }), "context_transition_conflict");
    expect(JSON.stringify(initial)).toBe(before);
  });

  it("rejects all operations when one owner is not admitted", () => {
    const initial = emptyContext();
    const denied = {
      ...contribution("history-2", "1", "history", null, "value"),
      source: { owner: "other", kind: "run_observation", id: "source-2", revision: "1", observedAt: at(1) },
    } satisfies ContextContribution;
    expectFailure(() => apply(initial, "denied", [
      { kind: "add", item: { id: "valid" }, contribution: contribution("history-1", "1", "history", null, "valid") },
      { kind: "add", item: { id: "invalid" }, contribution: denied },
    ]), "context_admission_rejected");
    expect(initial.items).toHaveLength(0);
  });

  it("removes payload while preserving a tombstone", () => {
    const initial = emptyContext();
    const value = contribution("history-1", "1", "history", null, "secret value");
    const added = apply(initial, "add", [{ kind: "add", item: { id: "item-1" }, contribution: value }]);
    const removed = apply(added, "remove", [{
      kind: "remove",
      item: { id: "item-1" },
      expectedContribution: value.ref,
      reason: "retention_expired",
    }]);
    expect("contribution" in removed.items[0]!).toBe(false);
    expect(JSON.stringify(removed)).not.toContain("secret value");
  });

  it("derives an owner replacement only from exact retained source lineage", () => {
    const initial = emptyContext();
    const first = contribution("current-1", "1", "current", "workspace", "first");
    const added = apply(initial, "add-current", [
      { kind: "add", item: { id: "item-current" }, contribution: first },
    ]);
    const replacement = contribution("current-1", "2", "current", "workspace", "second");
    const operation = deriveContextRefreshOperation({
      context: added,
      proposal: refreshProposal(added, first, replacement),
      maxContributionPayloadBytes: 1_024,
    });

    expect(operation).toMatchObject({
      kind: "replace",
      item: { id: "item-current" },
      expectedContribution: first.ref,
      contribution: { ref: replacement.ref },
    });
  });

  it("rejects a refresh whose source revision is stale", () => {
    const initial = emptyContext();
    const first = contribution("current-1", "1", "current", "workspace", "first");
    const added = apply(initial, "add-current", [
      { kind: "add", item: { id: "item-current" }, contribution: first },
    ]);
    const proposal = refreshProposal(
      added,
      first,
      contribution("current-1", "2", "current", "workspace", "second"),
    );
    expectFailure(() => deriveContextRefreshOperation({
      context: added,
      proposal: {
        ...proposal,
        target: {
          ...proposal.target,
          source: { ...proposal.target.source, revision: "stale" },
        },
      },
      maxContributionPayloadBytes: 1_024,
    }), "context_transition_conflict");
  });
});

function emptyContext() {
  return createEmptyActiveContext({ id: "context-1", runId: "run-1", createdAt: at(0) });
}

function apply(context: ReturnType<typeof emptyContext>, id: string, operations: import("./ContextTransition.js").ContextTransitionOperation[]) {
  return applyContextTransition({
    context,
    transition: transition(context.ref, id, operations),
    admission: profile(),
    maxContributionPayloadBytes: 1_024,
  });
}

function transition(base: import("./ActiveContext.js").ActiveContextRef, id: string, operations: import("./ContextTransition.js").ContextTransitionOperation[]) {
  return Object.freeze({
    id: `transition-${id}`,
    base,
    proposer: Object.freeze({ owner: "runtime", kind: "runner", id: "run-1" }),
    cause: Object.freeze({ kind: "test", id: null }),
    correlationId: null,
    operations: Object.freeze(operations),
    createdAt: at(base.version + 1),
  });
}

function contribution(id: string, revision: string, retention: "history" | "current", replacementKey: string | null, text: string): ContextContribution {
  const payload = Object.freeze({ kind: "text" as const, text });
  return Object.freeze({
    ref: Object.freeze({ id, revision }),
    source: Object.freeze({ owner: "runtime", kind: "run_observation", id: `source-${id}`, revision, observedAt: at(1) }),
    payload,
    scope: Object.freeze({ runId: "run-1", ownerScope: null }),
    disclosure: Object.freeze({ sensitivity: "internal" as const, audiences: Object.freeze(["model"]) }),
    handling: Object.freeze({ retention, replacementKey, instructionRole: "data" as const, necessity: "optional" as const, precedence: 10, allowedTransformations: Object.freeze(["truncate" as const]) }),
    provenance: Object.freeze([{ owner: "runtime", kind: "run_item", id: `run-item-${id}`, revision }]),
    createdAt: at(1),
    accounting: measureContextPayload(payload),
  });
}

function profile(): ContextAdmissionProfile {
  return Object.freeze({
    ref: Object.freeze({ id: "runtime-context-admission", revision: "1" }),
    owner: "runtime",
    sourceKinds: Object.freeze(["run_observation"]),
    disclosure: Object.freeze({ sensitivity: "internal", audiences: Object.freeze(["model"]) }),
    retention: Object.freeze(["history", "current"]),
    instructionRoles: Object.freeze(["data"]),
    necessities: Object.freeze(["optional"]),
    maximumPrecedence: 100,
    transformations: Object.freeze(["truncate"]),
  });
}

function refreshProposal(
  context: ReturnType<typeof emptyContext>,
  retained: ContextContribution,
  replacement: ContextContribution,
) {
  return Object.freeze({
    id: "refresh-1",
    kind: "replace" as const,
    owner: retained.source.owner,
    target: Object.freeze({
      context: context.ref,
      item: Object.freeze({ id: "item-current" }),
      contribution: retained.ref,
      source: Object.freeze({
        owner: retained.source.owner,
        kind: retained.source.kind,
        id: retained.source.id,
        revision: retained.source.revision,
      }),
    }),
    cause: "owner_refresh",
    correlationId: null,
    contribution: replacement,
    createdAt: at(2),
  });
}

function at(offset: number): string {
  return new Date(Date.parse("2026-01-01T00:00:00.000Z") + offset * 1_000).toISOString();
}

function expectFailure(input: () => unknown, code: string): void {
  try {
    input();
    throw new Error("Expected Context transition failure.");
  } catch (error) {
    expect(error).toBeInstanceOf(ContextContractError);
    expect((error as ContextContractError).failure.code).toBe(code);
  }
}

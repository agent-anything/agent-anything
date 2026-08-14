import { describe, expect, it } from "vitest";
import { ContextContractError } from "../contract/ContextContract.js";
import type { ContextContribution } from "./ContextContribution.js";
import {
  isContextDisclosureAtLeastAsRestrictive,
  snapshotContextContribution,
} from "./ContextContribution.js";

describe("ContextContribution contract", () => {
  it("preserves owner attribution and creates an immutable snapshot", () => {
    const snapshot = snapshotContextContribution(contribution(), {
      maxPayloadBytes: 64,
    });

    expect(snapshot.source).toEqual({
      owner: "tool:workspace.read",
      kind: "tool_result",
      id: "result-1",
      revision: "1",
      observedAt: "2026-08-14T00:00:00.000Z",
    });
    expect(snapshot.provenance[0]?.owner).toBe("tool:workspace.read");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.payload)).toBe(true);
    expect(Object.isFrozen(snapshot.disclosure.audiences)).toBe(true);
  });

  it("rejects unsupported fields and inconsistent measured accounting", () => {
    const withUnknownField = {
      ...contribution(),
      metadata: { bypass: true },
    } as ContextContribution;
    expectFailure(
      () => snapshotContextContribution(withUnknownField, { maxPayloadBytes: 64 }),
      "context_contract_invalid",
    );

    const withFalseAccounting: ContextContribution = {
      ...contribution(),
      accounting: { unit: "bytes", payloadBytes: 4 },
    };
    expectFailure(
      () => snapshotContextContribution(withFalseAccounting, { maxPayloadBytes: 64 }),
      "context_contract_invalid",
    );
  });

  it("rejects an over-limit payload before it can enter Active Context", () => {
    expectFailure(
      () => snapshotContextContribution(contribution(), { maxPayloadBytes: 4 }),
      "context_payload_too_large",
    );
  });

  it("makes current replacement identity explicit and forbids it on history", () => {
    const current: ContextContribution = {
      ...contribution(),
      handling: {
        ...contribution().handling,
        retention: "current",
        replacementKey: "workspace:primary",
      },
    };
    expect(
      snapshotContextContribution(current, { maxPayloadBytes: 64 }).handling
        .replacementKey,
    ).toBe("workspace:primary");

    expectFailure(
      () => snapshotContextContribution({
        ...contribution(),
        handling: {
          ...contribution().handling,
          replacementKey: "not-allowed-on-history",
        },
      }, { maxPayloadBytes: 64 }),
      "context_contract_invalid",
    );
  });

  it("allows disclosure to become more restrictive but never broader", () => {
    const current = {
      sensitivity: "internal" as const,
      audiences: ["provider:primary", "host:desktop"],
    };
    expect(isContextDisclosureAtLeastAsRestrictive({
      sensitivity: "restricted",
      audiences: ["provider:primary"],
    }, current)).toBe(true);
    expect(isContextDisclosureAtLeastAsRestrictive({
      sensitivity: "public",
      audiences: ["provider:primary"],
    }, current)).toBe(false);
    expect(isContextDisclosureAtLeastAsRestrictive({
      sensitivity: "restricted",
      audiences: ["provider:primary", "unapproved:consumer"],
    }, current)).toBe(false);
    expect(isContextDisclosureAtLeastAsRestrictive({
      sensitivity: "restricted",
      audiences: [],
    }, current)).toBe(true);
  });
});

function contribution(): ContextContribution {
  return {
    ref: { id: "contribution-1", revision: "1" },
    source: {
      owner: "tool:workspace.read",
      kind: "tool_result",
      id: "result-1",
      revision: "1",
      observedAt: "2026-08-14T00:00:00.000Z",
    },
    payload: { kind: "text", text: "hello" },
    scope: { runId: "run-1", ownerScope: null },
    disclosure: {
      sensitivity: "internal",
      audiences: ["provider:primary"],
    },
    handling: {
      retention: "history",
      replacementKey: null,
      instructionRole: "data",
      necessity: "optional",
      precedence: 10,
      allowedTransformations: ["truncate", "redact"],
    },
    provenance: [{
      owner: "tool:workspace.read",
      kind: "tool_result",
      id: "result-1",
      revision: "1",
    }],
    createdAt: "2026-08-14T00:00:00.000Z",
    accounting: { unit: "bytes", payloadBytes: 5 },
  };
}

function expectFailure(
  action: () => unknown,
  code: ContextContractError["failure"]["code"],
): void {
  try {
    action();
    throw new Error("Expected Context contract failure.");
  } catch (error) {
    expect(error).toBeInstanceOf(ContextContractError);
    expect((error as ContextContractError).failure.code).toBe(code);
    expect((error as ContextContractError).failure.path.length).toBeGreaterThan(0);
  }
}

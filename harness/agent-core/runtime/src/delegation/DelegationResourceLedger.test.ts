import { describe, expect, it } from "vitest";
import { createDelegationLimits } from "./DelegationRequest.js";
import {
  createDelegationResourceCapacity,
  DelegationResourceLedger,
} from "./DelegationResourceLedger.js";

describe("DelegationResourceLedger", () => {
  it("reserves finite root capacity and releases unused reservations", () => {
    const limits = delegationLimits();
    const ledger = new DelegationResourceLedger(
      createDelegationResourceCapacity({
        perDescendant: limits,
        maxTotalDescendants: 2,
      }),
    );

    expect(ledger.reserve("request-1", limits)).toEqual({
      status: "accepted",
      requestId: "request-1",
    });
    expect(ledger.reserve("request-2", limits)).toEqual({
      status: "accepted",
      requestId: "request-2",
    });
    expect(ledger.reserve("request-3", limits)).toEqual({
      status: "rejected",
      code: "delegation_resource_limit_exceeded",
    });

    ledger.release("request-2");
    expect(ledger.settle("request-1", {
      controllerTurns: 1,
      actions: 2,
      contextBytes: 80,
      resultBytes: 40,
    }).status).toBe("settled");
    expect(ledger.reserve("request-3", limits).status).toBe("accepted");
  });

  it("keeps settled usage charged and reports reservation overruns", () => {
    const limits = delegationLimits();
    const ledger = new DelegationResourceLedger(
      createDelegationResourceCapacity({
        perDescendant: limits,
        maxTotalDescendants: 2,
      }),
    );

    ledger.reserve("request-1", limits);
    expect(ledger.settle("request-1", {
      controllerTurns: 3,
      actions: 1,
      contextBytes: 10,
      resultBytes: 10,
    })).toMatchObject({ status: "limit_exceeded" });
    expect(ledger.reserve("request-2", limits)).toEqual({
      status: "rejected",
      code: "delegation_resource_limit_exceeded",
    });
  });
});

function delegationLimits() {
  return createDelegationLimits({
    maxControllerTurns: 2,
    maxActions: 3,
    maxDurationMs: 1_000,
    maxContextBytes: 100,
    maxResultBytes: 50,
  });
}

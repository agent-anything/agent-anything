import { describe, expect, it } from "vitest";
import {
  RunTreeResourceAccount,
  type RunTreeResourceAmounts,
  type RunTreeResourceEnvelope,
} from "./RunTreeResourceAccount.js";

describe("RunTreeResourceAccount", () => {
  it("transfers one finite allocation through root, child, and grandchild", () => {
    const account = new RunTreeResourceAccount("root", envelope(100));
    expect(account.record("root", measured(10)).status).toBe("recorded");
    expect(account.reserve("root", "child", amounts(60))).toEqual({ status: "accepted" });
    expect(account.reserve("child", "grandchild", amounts(30))).toEqual({ status: "accepted" });

    account.record("grandchild", measured(10));
    expect(account.settle("grandchild").released.controllerTurns).toBe(20);
    account.record("child", measured(20));
    expect(account.settle("child").released.controllerTurns).toBe(30);

    const snapshot = account.getSnapshot("root");
    expect(snapshot.controllerTurns).toMatchObject({
      capacity: 100,
      consumed: 40,
      reserved: 0,
      remaining: 60,
    });
  });

  it("narrows allocation to remaining parent capacity without copying it", () => {
    const account = new RunTreeResourceAccount("root", envelope(100));
    expect(account.reserve("root", "child-a", amounts(70)).status).toBe("accepted");
    expect(account.reserve("root", "child-b", amounts(31))).toEqual({ status: "accepted" });
    expect(account.getNodeSnapshot("child-b").allocation.controllerTurns).toBe(30);
    expect(account.reserve("root", "child-c", amounts(1))).toMatchObject({
      status: "rejected",
      code: "descendant_run_resource_limit_exceeded",
      dimension: "controllerTurns",
    });
  });

  it("retains unavailable capacity and rejects duplicate settlement", () => {
    const account = new RunTreeResourceAccount("root", envelope(100));
    account.reserve("root", "child", amounts(40));
    expect(account.record("child", {
      modelInputTokens: Object.freeze({ status: "unavailable" as const }),
    })).toMatchObject({ status: "measurement_unavailable" });
    expect(account.settle("child")).toMatchObject({
      status: "measurement_unavailable",
      released: { modelInputTokens: 0 },
    });
    expect(() => account.settle("child")).toThrow(/already settled/);
  });

  it("records observational overage without enforcing a Run failure", () => {
    const account = new RunTreeResourceAccount("root", Object.freeze({
      ...envelope(100),
      modelInputTokens: Object.freeze({
        maximum: 10,
        enforcement: "observational" as const,
      }),
    }));

    expect(account.record("root", {
      modelInputTokens: Object.freeze({ status: "measured" as const, value: 12 }),
    })).toEqual({ status: "recorded" });
    expect(account.getSnapshot("root").modelInputTokens).toMatchObject({
      capacity: 10,
      consumed: 12,
      remaining: 0,
      enforcement: "observational",
    });
    expect(account.settle("root").status).toBe("settled");
  });
});

function envelope(maximum: number): RunTreeResourceEnvelope {
  return Object.freeze({
    controllerTurns: { maximum, enforcement: "hard" },
    actions: { maximum, enforcement: "hard" },
    modelInputTokens: { maximum, enforcement: "hard" },
    modelOutputTokens: { maximum, enforcement: "hard" },
    costUnits: { maximum, enforcement: "hard" },
    contextBytes: { maximum, enforcement: "hard" },
    resultBytes: { maximum, enforcement: "hard" },
  });
}

function amounts(value: number): RunTreeResourceAmounts {
  return Object.freeze({
    controllerTurns: value,
    actions: value,
    modelInputTokens: value,
    modelOutputTokens: value,
    costUnits: value,
    contextBytes: value,
    resultBytes: value,
  });
}

function measured(value: number) {
  return Object.freeze({
    controllerTurns: Object.freeze({ status: "measured" as const, value }),
    actions: Object.freeze({ status: "measured" as const, value }),
    modelInputTokens: Object.freeze({ status: "measured" as const, value }),
    modelOutputTokens: Object.freeze({ status: "measured" as const, value }),
    costUnits: Object.freeze({ status: "measured" as const, value }),
    contextBytes: Object.freeze({ status: "measured" as const, value }),
    resultBytes: Object.freeze({ status: "measured" as const, value }),
  });
}

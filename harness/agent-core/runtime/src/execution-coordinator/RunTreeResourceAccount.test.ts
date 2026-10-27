import { describe, expect, it } from "vitest";
import {
  RunTreeResourceAccount,
  type RunTreeResourceAmounts,
  type RunTreeResourceEnvelope,
} from "./RunTreeResourceAccount.js";

describe("RunTreeResourceAccount", () => {
  it("restores nested reservations, unknown usage and released capacity without resetting or charging twice", () => {
    const account = new RunTreeResourceAccount("root", envelope(100));
    account.reserve("root", "child", amounts(60));
    account.reserve("child", "grandchild", amounts(30));
    account.record("grandchild", measured(10));
    account.record("grandchild", {modelInputTokens: {status: "unknown"}});
    account.settle("grandchild");
    const saved = account.checkpoint();
    const restored = RunTreeResourceAccount.restore(saved);
    expect(restored.checkpoint()).toEqual(saved);
    expect(restored.getSnapshot("root")).toEqual(account.getSnapshot("root"));
    expect(() => restored.settle("grandchild")).toThrow(/already settled/);
    restored.record("child", measured(10));
    account.record("child", measured(10));
    expect(restored.settle("child")).toEqual(account.settle("child"));
    expect(restored.getSnapshot("root")).toEqual(account.getSnapshot("root"));
    expect(RunTreeResourceAccount.restore(restored.checkpoint()).settle("root")).toEqual(account.settle("root"));
  });

  it("rejects inconsistent accounting and resource lineage", () => {
    const account = new RunTreeResourceAccount("root", envelope(100));
    account.reserve("root", "child", amounts(30));
    const saved = account.checkpoint();
    expect(() => RunTreeResourceAccount.restore({...saved, measuredConsumed: amounts(1)})).toThrow(/totals/);
    expect(() => RunTreeResourceAccount.restore({...saved, nodes: saved.nodes.map(node => node.runId === "child"
      ? {...node, parentRunId: "child"} : node)})).toThrow(/lineage/);
    account.record("child", {actions: {status: "unknown"}});
    account.settle("child");
    const settled = account.checkpoint();
    expect(() => RunTreeResourceAccount.restore({...settled, nodes: settled.nodes.map(node => node.runId === "child"
      ? {...node, settlement: {...node.settlement!, status: "settled"}} : node)})).toThrow(/status/);
    expect(() => RunTreeResourceAccount.restore({...saved, envelope: envelope(200)})).toThrow(/envelope/);
  });
  it("transfers one finite allocation through root, child, and grandchild", () => {
    const account = new RunTreeResourceAccount("root", envelope(100));
    expect(account.record("root", measured(10)).status).toBe("recorded");
    expect(account.reserve("root", "child", amounts(60))).toMatchObject({ status: "accepted" });
    expect(account.reserve("child", "grandchild", amounts(30))).toMatchObject({ status: "accepted" });

    account.record("grandchild", measured(10));
    expect(account.settle("grandchild").released.controllerTurns).toBe(20);
    account.record("child", measured(20));
    expect(account.settle("child").released.controllerTurns).toBe(30);

    const snapshot = account.getSnapshot("root");
    expect(snapshot.controllerTurns).toMatchObject({
      capacity: 100,
      measuredConsumed: 40,
      activeReserved: 0,
      available: 60,
    });
  });

  it("rejects an allocation that exceeds exact remaining parent capacity", () => {
    const account = new RunTreeResourceAccount("root", envelope(100));
    expect(account.reserve("root", "child-a", amounts(70)).status).toBe("accepted");
    expect(account.reserve("root", "child-b", amounts(31))).toMatchObject({
      status: "rejected",
      code: "descendant_run_resource_limit_exceeded",
      dimension: "controllerTurns",
    });
    expect(account.reserve("root", "child-b", amounts(30))).toMatchObject({
      status: "accepted",
      requestedAllocation: { controllerTurns: 30 },
      hardGrant: { controllerTurns: 30 },
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
        threshold: 10,
        enforcement: "observational" as const,
      }),
    }));

    expect(account.record("root", {
      modelInputTokens: Object.freeze({ status: "measured" as const, value: 12 }),
    })).toEqual({ status: "recorded" });
    expect(account.getSnapshot("root").modelInputTokens).toMatchObject({
      threshold: 10,
      observed: 12,
      overage: 2,
      enforcement: "observational",
    });
    expect(account.settle("root").status).toBe("settled");
  });
});

function envelope(maximum: number): RunTreeResourceEnvelope {
  return Object.freeze({
    controllerTurns: { maximum, minimumChildGrant: 1, enforcement: "hard" },
    actions: { maximum, minimumChildGrant: 1, enforcement: "hard" },
    modelInputTokens: { maximum, minimumChildGrant: 1, enforcement: "hard" },
    modelOutputTokens: { maximum, minimumChildGrant: 1, enforcement: "hard" },
    costUnits: { maximum, minimumChildGrant: 1, enforcement: "hard" },
    contextBytes: { maximum, minimumChildGrant: 1, enforcement: "hard" },
    resultBytes: { maximum, minimumChildGrant: 1, enforcement: "hard" },
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

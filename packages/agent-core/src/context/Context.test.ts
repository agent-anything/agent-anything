import { describe, expect, it } from "vitest";
import { applyPlanUpdate } from "../plan/index.js";
import type { ActionRejectedObservation } from "../runner/index.js";
import type { AgentTask } from "../task/index.js";
import {
  applyContextUpdate,
  createInitialContext,
  projectContext,
} from "./Context.js";

describe("Context transitions", () => {
  it("creates invocation-local Context without retaining task identity as state ownership", () => {
    const context = createInitialContext(createTask());

    expect(context).toEqual({
      messages: [],
      observations: [],
      evidenceRefs: [],
      metadata: {
        source: "test",
        taskKind: "test.agent.run",
        createdAt: "2026-07-13T00:00:00.000Z",
      },
    });
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.messages)).toBe(true);
  });

  it("applies an immutable append-only update and deduplicates evidence references", () => {
    const initial = createInitialContext(createTask());
    const observation = createObservation();
    const updated = applyContextUpdate(initial, {
      messages: [{
        id: "message-1",
        role: "assistant",
        content: "Inspected the workspace.",
        metadata: {},
      }],
      observations: [observation],
      evidenceRefs: ["evidence-1", "evidence-1"],
      metadata: { iteration: 1 },
    });

    expect(initial.messages).toEqual([]);
    expect(initial.observations).toEqual([]);
    expect(initial.evidenceRefs).toEqual([]);
    expect(updated.messages).toHaveLength(1);
    expect(updated.observations).toEqual([observation]);
    expect(updated.evidenceRefs).toEqual(["evidence-1"]);
    expect(updated.metadata).toMatchObject({ source: "test", iteration: 1 });
    expect(Object.isFrozen(updated.observations)).toBe(true);
  });

  it("projects prior Context and the current Plan through one immutable value", () => {
    const context = applyContextUpdate(createInitialContext(createTask()), {
      observations: [createObservation()],
    });
    const planResult = applyPlanUpdate({
      currentPlan: null,
      newPlanId: "plan-1",
      candidate: {
        plan: [{ step: "Inspect the workspace", status: "in_progress" }],
      },
      limits: createPlanLimits(),
      now: "2026-07-13T00:01:00.000Z",
    });
    if (planResult.status !== "applied") {
      throw new Error("Expected Plan creation to succeed.");
    }

    const permission = permissionProjection();
    const projection = projectContext(context, planResult.plan, permission);

    expect(projection.observations).toEqual(context.observations);
    expect(projection.permission).toBe(permission);
    expect(projection.plan).toEqual({
      id: "plan-1",
      version: 1,
      status: "active",
      steps: [{ step: "Inspect the workspace", status: "in_progress" }],
    });
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.plan)).toBe(true);
    expect(Object.isFrozen(projection.plan?.steps)).toBe(true);
  });
});

function permissionProjection() {
  return {
    profile: {
      profileId: ":read-only",
      sourceProfileIds: [":read-only"],
      environmentId: "test",
      enforcement: "managed" as const,
      workspaceRootCount: 1,
      fileSystem: {
        unrestricted: false,
        allowsRead: true,
        allowsWrite: false,
        hasDenials: false,
        managed: false,
      },
      network: {
        enabled: false,
        profileRestricted: false,
        managedRestricted: false,
        hasDenials: false,
      },
      managedConstraintSetId: "test",
      canRequestAdditionalPermissions: false,
    },
    authority: {
      hasAdditionalFileSystemRead: false,
      hasAdditionalFileSystemWrite: false,
      hasAdditionalNetwork: false,
      actionCoverageCount: 0,
      runGrantCount: 0,
      sessionAuthorityCount: 0,
      policyAmendmentCount: 0,
    },
    approval: {
      canRequest: false,
      reviewer: null,
      pending: false,
      requestsRemaining: 0,
    },
  };
}

function createTask(): AgentTask {
  return {
    id: "task-1",
    kind: "test.agent.run",
    input: {},
    createdAt: "2026-07-13T00:00:00.000Z",
    metadata: { source: "test" },
  };
}

function createObservation(): ActionRejectedObservation {
  return {
    id: "observation-1",
    runId: "run-1",
    actionId: "action-1",
    kind: "action_rejected",
    code: "action_unsupported",
    message: "Action is not supported.",
    createdAt: "2026-07-13T00:00:01.000Z",
    metadata: {},
  };
}

function createPlanLimits() {
  return {
    maxSteps: 10,
    maxStepLength: 200,
    maxExplanationLength: 500,
  };
}

import type { Controller } from "@agent-anything/agent-core";
import type {
  ControllerCallContext,
  ControllerDecision,
  ControllerInput,
} from "@agent-anything/agent-core/controller";
import {
  createRunCancellationController,
  type Observation,
} from "@agent-anything/agent-core/run";
import type {
  HelarcPatchReviewBridge,
  HelarcPatchReviewDecisionSubmission,
  HelarcPatchReviewRequest,
} from "../composition/HelarcPatchReview.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HelarcAgentOutput } from "../controller/index.js";
import { createHelarcTask } from "../task/index.js";
import { HelarcPatchActionController } from "./HelarcPatchActionController.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("HelarcPatchActionController", () => {
  it("projects Action submission and settles permission denial from Runner Observation", async () => {
    const fixture = await createFixture();
    const controller = createController();
    const first = await controller.next(
      createInput(fixture.task, []),
      createCallContext(),
    );

    expect(first).toMatchObject({
      kind: "actions",
      actions: [{ name: "codeAgent.updateFile" }],
    });
    expect(controller.getProductPhase()).toMatchObject({
      kind: "patch_action_submitted",
      runId: "run-1",
      pendingVersion: 1,
    });

    const settled = await controller.next(
      createInput(fixture.task, [actionDenied()]),
      createCallContext(),
    );
    expect(settled.kind).toBe("final_output");
    expect(controller.getProductPhase()).toEqual({ kind: "none" });
    expect(controller.getPatchOutcome()).toMatchObject({
      productStatus: "failed",
      patchStatus: "failed",
      appliedPath: null,
      errors: [{ code: "permission_denied" }],
    });
  });

  it("settles execution failure without claiming an applied patch", async () => {
    const fixture = await createFixture();
    const controller = createController();
    await controller.next(createInput(fixture.task, []), createCallContext());

    await controller.next(
      createInput(fixture.task, [actionFailure()]),
      createCallContext(),
    );

    expect(controller.getPatchOutcome()).toMatchObject({
      productStatus: "failed",
      patchStatus: "failed",
      appliedPath: null,
      errors: [{ code: "filesystem_write_failed", message: "Write failed." }],
    });
  });
});

function createController(): HelarcPatchActionController {
  return new HelarcPatchActionController({
    controller: new ProposalController(),
    patchReviewBridge: new AcceptingReviewBridge(),
    now: () => "2026-07-17T00:00:00.000Z",
  });
}

class ProposalController implements Controller<HelarcAgentOutput> {
  async next(): Promise<ControllerDecision<HelarcAgentOutput>> {
    return {
      kind: "final_output",
      output: {
        kind: "propose",
        summary: "Update file",
        change: { operation: "update", path: "src/file.txt", content: "after\n" },
      },
      modelItems: [{
        id: "model-1",
        kind: "assistant_action",
        content: { action: "propose" },
        metadata: {},
      }],
    };
  }
}

class AcceptingReviewBridge implements HelarcPatchReviewBridge {
  readonly runId = "run-1";

  getPendingProjection() {
    return null;
  }

  subscribe() {
    return () => undefined;
  }

  async review(request: HelarcPatchReviewRequest) {
    const submission: HelarcPatchReviewDecisionSubmission = {
      submissionId: "submission-1",
      runId: request.runId,
      proposalId: request.proposalId,
      reviewId: request.reviewId,
      pendingVersion: 1,
      decision: "accepted",
      reason: "Accept in product test.",
    };
    return { status: "decided" as const, submission };
  }

  submitDecision() {
    return {
      status: "rejected" as const,
      submissionId: "",
      code: "patch_review_not_pending" as const,
    };
  }
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "helarc-patch-controller-"));
  roots.push(root);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "file.txt"), "before\n");
  const taskResult = createHelarcTask({
    taskId: "task-1",
    prompt: "Update file",
    workspace: { id: "workspace-1", name: "Workspace", rootRef: root },
  });
  if (!taskResult.ok) throw new Error(taskResult.error.message);
  return { task: taskResult.task };
}

function createInput(
  task: ReturnType<typeof createFixture> extends Promise<infer T>
    ? T extends { task: infer TTask } ? TTask : never
    : never,
  observations: readonly Observation[],
): ControllerInput<HelarcAgentOutput> {
  const workspace = task.workspaceScope!.roots[task.workspaceScope!.defaultRootName!];
  return {
    runId: "run-1",
    iteration: observations.length === 0 ? 1 : 2,
    agent: {
      id: "helarc",
      name: "Helarc",
      instructions: "Complete task.",
      tools: [],
      output: { validate: (candidate) => ({ valid: true, output: candidate as HelarcAgentOutput }) },
      metadata: {},
    },
    task,
    conversationItems: [],
    context: {
      messages: [],
      observations,
      evidenceRefs: [],
      plan: null,
      permission: {},
      metadata: {},
    } as unknown as ControllerInput<HelarcAgentOutput>["context"],
    workspace: workspace!,
    identity: {
      id: "identity-1",
      kind: "anonymous",
      displayName: "User",
      metadata: {},
    },
    metadata: {},
  };
}

function createCallContext(): ControllerCallContext {
  const policy = {
    maxRetries: 0,
    delay: {
      kind: "exponential_jitter" as const,
      baseDelayMs: 0,
      maxDelayMs: 0,
      multiplier: 2 as const,
      jitterRatio: 0.1 as const,
    },
    retryableCategories: [] as string[],
    serverDelay: { mode: "ignore" as const },
  };
  return {
    cancellation: createRunCancellationController({ runId: "run-1" }).context,
    retry: {
      providerRequest: policy,
      structuredOutput: policy,
      deadlineAt: "2099-01-01T00:00:00.000Z",
      events: { emit() {} },
    },
  };
}

function actionDenied(): Observation {
  return {
    id: "observation-denied",
    kind: "action_denied",
    runId: "run-1",
    actionId: "action-1",
    owner: "permission",
    code: "permission_denied",
    message: "Permission denied.",
    createdAt: "2026-07-17T00:00:01.000Z",
    metadata: { actionName: "codeAgent.updateFile" },
  };
}

function actionFailure(): Observation {
  return {
    id: "observation-failed",
    kind: "action_failure",
    runId: "run-1",
    actionId: "action-1",
    error: {
      owner: "tool",
      code: "filesystem_write_failed",
      message: "Write failed.",
      retryable: false,
      metadata: {},
    },
    createdAt: "2026-07-17T00:00:01.000Z",
    metadata: { actionName: "codeAgent.updateFile" },
  };
}

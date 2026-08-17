import { createHash } from "node:crypto";
import type { Controller } from "@agent-anything/agent-runtime/controller";
import type {
  ControllerCallContext,
  ControllerDecision,
  ControllerInput,
  ProgressionCandidate,
} from "@agent-anything/agent-runtime/controller";
import {
  createRunCancellationController,
  type RunObservation,
} from "@agent-anything/agent-runtime/run";
import { createToolCatalogSnapshot } from "@agent-anything/tools/catalog";
import {
  bindingRefForCodeFileTool,
  CODE_AGENT_UPDATE_FILE_TOOL,
  operationRefForCodeFileTool,
} from "@agent-anything/helarc-code-agent/file-operation";
import type {
  CodeSourcePort,
  CodeSourceSnapshot,
} from "@agent-anything/helarc-code-agent/source";
import { describe, expect, it } from "vitest";
import { HELARC_PATCH_REVIEW_PROTOCOL } from "../composition/HelarcPatchReview.js";
import type { HelarcAgentOutput } from "../controller/index.js";
import { createHelarcTask } from "../task/index.js";
import { HelarcPatchActionController } from "./HelarcPatchActionController.js";

describe("HelarcPatchActionController", () => {
  it("submits an accepted proposal as an Operation request and settles denial", async () => {
    const controller = createController();
    const { reviewDecision, interactionObservation } = await acceptPendingReview(controller);

    expect(reviewDecision).toMatchObject({
      kind: "advance",
      candidates: [{
        kind: "operation_request",
        origin: "tool_request",
        tool: {
          name: CODE_AGENT_UPDATE_FILE_TOOL,
          origin: "workflow",
          input: {
            rootName: "Workspace",
            path: "src/file.txt",
            content: "after\n",
          },
        },
      }],
    });
    expect(controller.getPatchState()).toMatchObject({
      kind: "action_submitted",
      runId: "run-1",
      requestVersion: 1,
    });

    const settled = await controller.next(
      createInput([interactionObservation, operationRejected()]),
      createCallContext(),
    );
    expect(settled.kind).toBe("propose_completion");
    expect(controller.getPatchState()).toEqual({ kind: "none" });
    expect(controller.getPatchOutcome()).toMatchObject({
      status: "failed",
      patchStatus: "failed",
      appliedPath: null,
      errors: [{ code: "permission_denied" }],
    });
  });

  it("settles Operation failure without claiming an applied patch", async () => {
    const controller = createController();
    const { interactionObservation } = await acceptPendingReview(controller);
    await controller.next(
      createInput([interactionObservation, operationFailure()]),
      createCallContext(),
    );

    expect(controller.getPatchOutcome()).toMatchObject({
      status: "failed",
      patchStatus: "failed",
      appliedPath: null,
      errors: [{ code: "filesystem_write_failed", message: "Write failed." }],
    });
  });
});

function createController(): HelarcPatchActionController {
  return new HelarcPatchActionController({
    controller: new ProposalController(),
    codeSource: fixedCodeSource(),
    now: () => "2026-07-17T00:00:00.000Z",
  });
}

class ProposalController implements Controller<HelarcAgentOutput> {
  async next(): Promise<ControllerDecision<HelarcAgentOutput>> {
    return {
      kind: "propose_completion",
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

async function acceptPendingReview(controller: HelarcPatchActionController): Promise<{
  readonly reviewDecision: ControllerDecision<HelarcAgentOutput>;
  readonly interactionObservation: RunObservation;
}> {
  const requestDecision = await controller.next(createInput([]), createCallContext());
  expect(requestDecision).toMatchObject({
    kind: "advance",
    candidates: [{
      kind: "interaction_request",
      protocol: HELARC_PATCH_REVIEW_PROTOCOL,
      requestVersion: 1,
      blockingScope: "run",
      presentation: {
        path: "src/file.txt",
        operation: "update",
        originalContent: "before\n",
        proposedContent: "after\n",
      },
    }],
  });
  expect(controller.getPatchState()).toMatchObject({
    kind: "review_requested",
    runId: "run-1",
    proposalRevision: 1,
  });
  if (requestDecision.kind !== "advance") {
    throw new Error("Expected a patch-review Interaction request.");
  }
  const candidate = requestDecision.candidates[0];
  if (candidate?.kind !== "interaction_request") {
    throw new Error("Expected a patch-review Interaction candidate.");
  }
  const interactionObservation = acceptedReviewObservation(candidate);
  const reviewDecision = await controller.next(
    createInput([interactionObservation]),
    createCallContext(),
  );
  return { reviewDecision, interactionObservation };
}

function acceptedReviewObservation(
  candidate: Extract<ProgressionCandidate, { readonly kind: "interaction_request" }>,
): RunObservation {
  return observation({
    kind: "interaction",
    owner: HELARC_PATCH_REVIEW_PROTOCOL.owner,
    status: "resolved",
    value: {
      kind: "helarc_patch_review_decision",
      request: {
        id: "patch-review-request-1",
        protocol: candidate.protocol,
        requestVersion: candidate.requestVersion,
        subject: candidate.subjectRef,
      },
      submissionId: "submission-1",
      decision: "accepted",
      reason: "Accept in product test.",
    },
  });
}

function createInput(observations: readonly RunObservation[]): ControllerInput<HelarcAgentOutput> {
  const taskResult = createHelarcTask({ taskId: "task-1", prompt: "Update file" });
  if (!taskResult.ok) throw new Error(taskResult.error.message);
  const catalog = createToolCatalogSnapshot([]);
  return {
    runId: "run-1",
    iteration: observations.length === 0 ? 1 : 2,
    agent: {
      id: "helarc",
      revision: "1",
      name: "Helarc",
      instructions: "Complete task.",
      output: { validate: (candidate) => ({ valid: true, output: candidate as HelarcAgentOutput }) },
      metadata: {},
    },
    task: taskResult.task,
    inputItems: [],
    toolExposure: {
      id: "exposure-1",
      selectionRevision: "selection-1",
      consumer: "controller",
      controllerRequestId: "controller-request-1",
      exposedTools: [],
      catalog,
    },
    context: contextProjection(observations),
    plan: null,
    permission: permissionProjection(),
    pending: [],
    workspace: {
      primary: {
        id: "workspace-1",
        name: "Workspace",
        rootRef: "memory://workspace-1",
        trustState: "trusted",
        source: "test",
        policyRefs: [],
        metadata: {},
      },
      additional: [],
    },
    identity: {
      id: "identity-1",
      kind: "anonymous",
      displayName: "User",
      metadata: {},
    },
    metadata: {},
  };
}

function contextProjection(
  observations: readonly RunObservation[],
): ControllerInput<HelarcAgentOutput>["context"] {
  const blocks = observations.map((observation, index) => ({
    id: `block-${index + 1}`,
    item: { id: `item-${index + 1}` },
    contribution: { id: `contribution-${index + 1}`, revision: "1" },
    instructionRole: "data" as const,
    payload: {
      kind: "structured" as const,
      value: { kind: "run_observation", observation } as never,
    },
    accounting: { unit: "bytes" as const, amount: 0 },
    transformation: null,
  }));
  return {
    id: "projection-1",
    requestId: "projection-request-1",
    activeContext: { id: "context-1", runId: "run-1", version: 1 },
    estimator: { id: "test", revision: "1", unit: "bytes" },
    blocks,
    accounting: { unit: "bytes", amount: 0 },
    manifestId: "manifest-1",
    createdAt: "2026-07-08T00:00:00.000Z",
  };
}

function permissionProjection(): ControllerInput<HelarcAgentOutput>["permission"] {
  return {
    profile: {
      profileId: "profile-1",
      sourceProfileIds: ["profile-1"],
      environmentId: "environment-1",
      enforcement: "enforced",
      workspaceRootCount: 1,
      fileSystem: {
        unrestricted: false,
        allowsRead: true,
        allowsWrite: false,
        hasDenials: false,
        managed: false,
      },
      process: { unrestricted: false },
      network: {
        enabled: false,
        profileRestricted: false,
        managedRestricted: false,
        hasDenials: false,
      },
      managedConstraintSetId: "constraints-1",
      canRequestAdditionalPermissions: true,
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
    approval: { canRequest: true, reviewer: "user", pendingCount: 0 },
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

function operationRejected(): RunObservation {
  return observation({
    kind: "operation_rejected",
    owner: "permission",
    code: "permission_denied",
    message: "Permission denied.",
  });
}

function operationFailure(): RunObservation {
  const operation = operationRefForCodeFileTool(CODE_AGENT_UPDATE_FILE_TOOL);
  return observation({
    kind: "operation",
    result: {
      ref: { invocation: { id: "operation-1", operation }, id: "result-1" },
      binding: bindingRefForCodeFileTool(CODE_AGENT_UPDATE_FILE_TOOL),
      semanticOwner: "helarc.code-workspace",
      status: "failed",
      output: null,
      failure: {
        owner: "helarc.local-environment",
        code: "filesystem_write_failed",
        message: "Write failed.",
        retryable: false,
        metadata: {},
      },
      startedAt: "2026-07-17T00:00:01.000Z",
      finishedAt: "2026-07-17T00:00:02.000Z",
      lowerRefs: [],
      metadata: {},
    },
    toolResult: null,
  });
}

function observation(payload: RunObservation["payload"]): RunObservation {
  return {
    id: `observation-${payload.kind}`,
    runId: "run-1",
    actionId: "action-1",
    kind: payload.kind,
    createdAt: "2026-07-17T00:00:02.000Z",
    metadata: {},
    owner: "agent-runtime",
    runAction: { run: { id: "run-1" }, id: "action-1", sequence: 1 },
    lowerRefs: [],
    payload,
  };
}

function fixedCodeSource(): CodeSourcePort {
  const snapshot = sourceSnapshot();
  return {
    async capture() {
      return { status: "captured" as const, snapshot };
    },
    async rehydrate() {
      return { status: "matched" as const, snapshot };
    },
  };
}

function sourceSnapshot(): CodeSourceSnapshot {
  const content = "before\n";
  const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  return {
    target: { rootName: "Workspace", workspaceId: "workspace-1", path: "src/file.txt" },
    baseline: {
      kind: "present",
      entryKind: "file",
      objectIdentity: { kind: "posix", deviceId: "memory", inode: "src/file.txt" },
      contentDigest: digest,
    },
    content,
    contentRef: { algorithm: "sha256", digest, byteLength: 7 },
    capturedAt: "2026-07-17T00:00:00.000Z",
  };
}

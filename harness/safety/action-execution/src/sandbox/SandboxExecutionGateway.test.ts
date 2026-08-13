import { describe, expect, it, vi } from "vitest";
import type { ActionExecutorDescriptor } from "@agent-anything/canonical-action/registration";
import { createPreparedActionInvocation } from "@agent-anything/canonical-action/subject";
import {
  assertActionExecutorDispatchContext,
  type ActionExecutor,
} from "../execution/ActionExecutor.js";
import type {
  SandboxExecutionRequest,
  SandboxProvider,
} from "./SandboxContracts.js";
import { createSandboxExecutionGateway } from "./SandboxExecutionGateway.js";

describe("SandboxExecutionGateway", () => {
  it("dispatches disabled enforcement only through a gateway-created executor permit", async () => {
    const execute = vi.fn<ActionExecutor["execute"]>(async (_invocation, context) => {
      assertActionExecutorDispatchContext(context);
      return {
        status: "completed",
        effectState: "settled",
        payload: { content: "hello" },
      };
    });
    const gateway = createSandboxExecutionGateway({
      executors: [createExecutor(execute)],
    });

    const result = await gateway.execute(createRequest());

    expect(result).toMatchObject({
      status: "settled",
      isolation: "unisolated",
      outcome: {
        status: "completed",
        effectState: "settled",
        payload: { content: "hello" },
      },
      enforcementEvidence: {
        providerId: "action-execution.disabled-passthrough",
        enforcement: "disabled",
      },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("fails closed before dispatch when the exact executor revision is unavailable", async () => {
    const gateway = createSandboxExecutionGateway({ executors: [] });

    await expect(gateway.execute(createRequest())).resolves.toMatchObject({
      status: "sandbox_unavailable",
      stage: "capability_check",
      code: "sandbox_executor_unavailable",
      effectState: "none",
    });
  });

  it("fails closed before provider dispatch when managed enforcement is unsupported", async () => {
    const providerExecute = vi.fn<SandboxProvider["execute"]>();
    const provider: SandboxProvider = {
      kind: "managed",
      descriptor: {
        id: "test.sandbox",
        version: "1",
        kind: "managed",
        supportedPolicyVersions: [2],
        supportedEffectFamilies: ["filesystem"],
      },
      execute: providerExecute,
      async cancel() {
        return { status: "accepted" };
      },
    };
    const gateway = createSandboxExecutionGateway({
      executors: [createExecutor()],
      providers: [provider],
    });

    await expect(gateway.execute(createRequest("managed", ["filesystem"])))
      .resolves.toMatchObject({
        status: "sandbox_unavailable",
        stage: "capability_check",
        code: "sandbox_policy_unsupported",
        effectState: "none",
      });
    expect(providerExecute).not.toHaveBeenCalled();
  });

  it("rejects an oversized physical result with unknown effect state", async () => {
    const execute = vi.fn<ActionExecutor["execute"]>(async () => ({
      status: "completed",
      effectState: "settled",
      payload: { content: "too large" },
    }));
    const gateway = createSandboxExecutionGateway({
      executors: [createExecutor(execute)],
    });
    const base = createRequest();
    const request: SandboxExecutionRequest = {
      ...base,
      policy: {
        ...base.policy,
        resourceLimits: { maxResultBytes: 2 },
      },
    };

    await expect(gateway.execute(request)).resolves.toMatchObject({
      status: "sandbox_unavailable",
      stage: "settlement",
      code: "executor_physical_outcome_invalid",
      effectState: "unknown",
    });
  });
});

function createExecutor(
  execute: ActionExecutor["execute"] = async () => ({
    status: "completed",
    effectState: "settled",
    payload: { content: "hello" },
  }),
): ActionExecutor {
  return {
    descriptor: EXECUTOR,
    validatePayload(candidate): candidate is { content: string } {
      return typeof candidate === "object" && candidate !== null &&
        "content" in candidate && typeof candidate.content === "string";
    },
    execute,
  };
}

function createRequest(
  enforcement: "managed" | "disabled" = "disabled",
  effectFamilies: readonly string[] = [],
): SandboxExecutionRequest {
  return {
    attempt: {
      action: { id: "action-1" },
      id: "attempt-1",
      ordinal: 1,
      runId: "run-1",
      actionFingerprint: SHA_A,
      enforcement,
      policyId: "policy-1",
      authoritySnapshotId: "authority-1",
      dispatchPlanFingerprint: SHA_B,
      actionRegistrationFingerprint: SHA_C,
      startedAt: NOW,
    },
    policy: {
      schemaVersion: 1,
      policyId: "policy-1",
      actionFingerprint: SHA_A,
      authoritySnapshotId: "authority-1",
      enforcement,
      defaultDisposition: "deny",
      effectFamilies,
      resourceLimits: { maxResultBytes: 64 * 1024 },
      allowedSecretReferences: [],
    },
    executor: EXECUTOR,
    actionRegistrationFingerprint: SHA_C,
    invocation: createPreparedActionInvocation({
      contractVersion: EXECUTOR.invocationContractVersion,
      executorId: EXECUTOR.id,
      executorVersion: EXECUTOR.version,
      payload: { path: "D:/workspace/README.md" },
    }),
    deadlineAt: "2026-08-13T00:01:00.000Z",
    interruption: {
      signal: new AbortController().signal,
      interruption: null,
    },
  };
}

const EXECUTOR: ActionExecutorDescriptor = Object.freeze({
  id: "test.executor",
  version: "1",
  invocationContractVersion: "1",
  physicalPayloadSchemaRevision: "payload-1",
});
const NOW = "2026-08-13T00:00:00.000Z";
const SHA_A = `sha256:${"a".repeat(64)}`;
const SHA_B = `sha256:${"b".repeat(64)}`;
const SHA_C = `sha256:${"c".repeat(64)}`;

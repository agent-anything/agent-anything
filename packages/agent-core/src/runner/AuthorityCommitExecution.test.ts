import { describe, expect, it, vi } from "vitest";
import {
  resolvePermissionProfile,
  type ApprovalRequest,
  type ValidatedApprovalDecision,
} from "@agent-anything/permission";
import type {
  ManagedPermissionConstraints,
  PersistentPolicyAmendmentCommit,
} from "@agent-anything/governance";
import { createRunCancellationController } from "./RunCancellation.js";
import {
  authorityCommitOwner,
  executeAuthorityCommit,
  type DurableAuthorityDecision,
} from "./AuthorityCommitExecution.js";
import type { ResolvedRunPermissionConfig } from "./RunPermissionConfig.js";
import type { PendingApproval } from "./RunPermissionState.js";

describe("executeAuthorityCommit", () => {
  it("attributes persistent commit settlement to policy", () => {
    expect(authorityCommitOwner(persistentDecision())).toBe("policy");
  });

  it("commits and correlates an exact persistent policy amendment", async () => {
    const commits: PersistentPolicyAmendmentCommit[] = [];
    let portOwnedRecord: object | null = null;
    const config = createConfig(async (input) => {
      commits.push(input);
      portOwnedRecord = {
        id: input.recordId,
        proposalRef: input.proposalRef,
        sourceRequestId: input.sourceRequestId,
        sourceActionFingerprint: input.sourceActionFingerprint,
        amendment: input.amendment,
        appliedAt: input.appliedAt,
      };
      return {
        kind: "applied",
        record: portOwnedRecord as PersistentPolicyAmendmentCommitResultRecord,
      };
    });

    const result = await executeAuthorityCommit(createInput(config));

    expect(result).toMatchObject({
      kind: "applied",
      owner: "policy",
      scope: "persistent",
      commitId: "authority_operation_1:commit",
      application: {
        kind: "applied",
        target: "policy_amendment",
        authorityRecordIds: ["policy_record_1"],
      },
    });
    expect(commits).toHaveLength(1);
    expect(Object.isFrozen(portOwnedRecord)).toBe(false);
  });

  it("normalizes a thrown persistent commit to outcome unknown", async () => {
    const config = createConfig(async () => {
      throw new Error("connection lost after write");
    });

    const result = await executeAuthorityCommit(createInput(config));

    expect(result).toMatchObject({
      kind: "outcome_unknown",
      owner: "policy",
      code: "policy_amendment_commit_outcome_unknown",
      application: {
        kind: "outcome_unknown",
        code: "policy_amendment_commit_outcome_unknown",
      },
    });
  });

  it("rejects a mismatched applied persistent record as outcome unknown", async () => {
    const config = createConfig(async (input) => ({
      kind: "applied",
      record: {
        id: "different_record",
        proposalRef: input.proposalRef,
        sourceRequestId: input.sourceRequestId,
        sourceActionFingerprint: input.sourceActionFingerprint,
        amendment: input.amendment,
        appliedAt: input.appliedAt,
      },
    }));

    const result = await executeAuthorityCommit(createInput(config));

    expect(result).toMatchObject({
      kind: "outcome_unknown",
      owner: "policy",
      code: "policy_amendment_commit_outcome_unknown",
    });
  });

  it("normalizes a malformed runtime result instead of throwing", async () => {
    const config = createConfig(async () => null as never);

    const result = await executeAuthorityCommit(createInput(config));

    expect(result).toMatchObject({
      kind: "outcome_unknown",
      owner: "policy",
      code: "policy_amendment_commit_outcome_unknown",
    });
  });

  it("interrupts commit at the shorter authority deadline", async () => {
    vi.useFakeTimers();
    try {
      const config = createConfig((_input, context) => new Promise((resolve) => {
        const settle = () => {
          if (context.interruption === null) {
            throw new Error("Commit deadline must carry interruption attribution.");
          }
          resolve({ kind: "interrupted", interruption: context.interruption });
        };
        context.signal.addEventListener("abort", settle, { once: true });
        if (context.signal.aborted) settle();
      }));

      const running = executeAuthorityCommit(createInput(config));
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await running;

      expect(result).toMatchObject({
        kind: "interrupted",
        owner: "policy",
        deadlineAt: "2026-07-15T00:00:01.000Z",
        interruption: {
          kind: "operation_deadline",
          deadline: {
            operationId: "authority_operation_1",
            deadlineAt: "2026-07-15T00:00:01.000Z",
          },
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves exact Run cancellation attribution during persistent commit", async () => {
    const cancellation = createRunCancellationController({
      runId: "run_001",
      createRequestId: () => "cancellation_001",
      now: () => "2026-07-15T00:00:00.500Z",
    });
    const config = createConfig((_input, context) => new Promise((resolve) => {
      const settle = () => {
        if (context.interruption === null) {
          throw new Error("Run cancellation must carry interruption attribution.");
        }
        resolve({ kind: "interrupted", interruption: context.interruption });
      };
      context.signal.addEventListener("abort", settle, { once: true });
      if (context.signal.aborted) settle();
    }));

    const running = executeAuthorityCommit(createInput(config, cancellation.context));
    const receipt = cancellation.requestCancellation({
      origin: "host",
      reasonCode: "host_requested",
    });
    const result = await running;

    expect(receipt.accepted).toBe(true);
    expect(result).toMatchObject({
      kind: "interrupted",
      owner: "policy",
      scope: "persistent",
      interruption: {
        kind: "run_cancellation",
        cancellation: {
          runId: "run_001",
          requestId: receipt.request.id,
        },
      },
      application: {
        kind: "interrupted",
        interruption: {
          kind: "run_cancellation",
          cancellation: {
            runId: "run_001",
            requestId: receipt.request.id,
          },
        },
      },
    });
  });
});

type PersistentPolicyAmendmentCommitResultRecord = Extract<
  Awaited<ReturnType<NonNullable<ResolvedRunPermissionConfig["persistentPolicyAmendments"]>["commit"]>>,
  { readonly kind: "applied" }
>["record"];

function createInput(
  config: ResolvedRunPermissionConfig,
  cancellation = createRunCancellationController({ runId: "run_001" }).context,
) {
  const decision = persistentDecision();
  return {
    decision,
    pending: pendingApproval(decision),
    config,
    cancellation,
    startedAt: "2026-07-15T00:00:00.000Z",
    deadlineAt: "2026-07-15T00:00:01.000Z",
    policyAmendmentRecordId: "policy_record_1",
    now: () => "2026-07-15T00:00:00.000Z",
  };
}

function persistentDecision(): DurableAuthorityDecision {
  return {
    kind: "acceptWithExecpolicyAmendment",
    optionId: "option_persistent",
    trustedProposalRef: "proposal_exec_1",
    amendment: {
      amendmentId: "amendment_1",
      environmentId: "test-local",
      commandPattern: ["git", "status"],
      cwd: "C:/workspace",
      effect: "allow",
      sourceFingerprint: "fingerprint_1",
    },
  };
}

function pendingApproval(
  decision: Extract<
    DurableAuthorityDecision,
    { readonly kind: "acceptWithExecpolicyAmendment" }
  >,
): PendingApproval & { readonly phase: "applying_authority" } {
  return {
    phase: "applying_authority",
    request: {
      id: "request_1",
      runId: "run_001",
      actionId: "action_1",
      actionFingerprint: "fingerprint_1",
      category: "commandExecution",
      subject: {
        runId: "run_001",
        actionId: "action_1",
        actionFingerprint: "fingerprint_1",
        environmentId: "test-local",
        applicabilityKeys: [],
      },
      reason: "Run git status.",
      payload: {
        command: ["git", "status"],
        safeCommandDisplay: "git status",
        cwd: "C:/workspace",
        cwdDisplay: "workspace",
        environmentId: "test-local",
        commandActions: [],
        additionalPermissions: null,
      },
      decisionOptions: [{
        id: "option_persistent",
        kind: "acceptWithExecpolicyAmendment",
        scope: "persistent",
        label: "Always allow",
        description: null,
        trustedProposalRef: "proposal_exec_1",
        metadata: {},
      }],
      trustedProposals: [{
        kind: "exec_policy_amendment",
        ref: "proposal_exec_1",
        amendment: decision.amendment,
      }],
      createdAt: "2026-07-15T00:00:00.000Z",
      deadlineAt: "2026-07-15T00:00:10.000Z",
      metadata: {},
    } as ApprovalRequest,
    reviewerBindingId: "reviewer_binding_1",
    reviewer: "auto_review",
    reviewOperationId: "review_operation_1",
    version: 1,
    createdAt: "2026-07-15T00:00:00.000Z",
    validatedDecision: decision as ValidatedApprovalDecision,
    authorityOperationId: "authority_operation_1",
  };
}

function createConfig(
  commit: NonNullable<ResolvedRunPermissionConfig["persistentPolicyAmendments"]>["commit"],
): ResolvedRunPermissionConfig {
  const managedConstraints: ManagedPermissionConstraints = {
    constraintSetId: "managed_1",
    selectableProfiles: { allowedProfileIds: null, deniedProfileIds: [] },
    fileSystem: [],
    network: { enabled: null, allowedDomains: [], deniedDomains: [] },
    allowUnenforcedExecution: false,
  };
  return {
    permissionProfile: resolvePermissionProfile({
      profileId: ":read-only",
      profiles: [],
      environment: {
        environmentId: "test-local",
        platform: "win32",
        workspaceRoots: [{ rootId: "workspace_001", path: "C:/workspace" }],
      },
      managedConstraints,
    }),
    approvalPolicy: "on-request",
    reviewer: null,
    rules: [],
    networkRules: [],
    managedConstraints,
    sessionAuthority: null,
    persistentPolicyAmendments: { commit },
    approvalLimits: {
      maxRequestsPerRun: 4,
      maxRequestsPerActionFingerprint: 2,
      maxConsecutiveDeclines: 2,
      maxConsecutiveReviewFailures: 2,
    },
    authorityApplicationLimits: { commitTimeoutMs: 1_000 },
  };
}

import type { InvocationInterruptionContext } from "@agent-anything/shared";
import { describe, expect, it } from "vitest";
import type {
  ApprovalRequirement,
  ApprovalReviewInput,
  ApprovalReviewOutcome,
  ApprovalReviewerPort,
} from "./ApprovalContracts.js";
import { ApprovalContractError } from "./ApprovalContractError.js";
import { createApprovalRequest } from "./createApprovalRequest.js";
import {
  projectApprovalReviewRequest,
  snapshotApprovalReviewContext,
} from "./projectApprovalReviewRequest.js";

describe("approval request snapshots", () => {
  it("creates an immutable request and a separately allocated safe review projection", () => {
    const metadata = { secret: "internal", nested: { value: 1 } };
    const requirement = commandRequirement(metadata);
    const request = createApprovalRequest({
      id: "request_1",
      requirement,
      createdAt: "2026-07-15T00:00:00.000Z",
    });
    const review = projectApprovalReviewRequest(request);

    metadata.nested.value = 2;
    expect(request.metadata).toEqual({ secret: "internal", nested: { value: 1 } });
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.payload)).toBe(true);
    expect(review.payload).not.toBe(request.payload);
    expect(review.decisionOptions).not.toBe(request.decisionOptions);

    const serialized = JSON.stringify(review);
    expect(serialized).toContain("pnpm test");
    expect(serialized).not.toContain("token-secret");
    expect(serialized).not.toContain("/work/repo");
    expect(serialized).not.toContain("proposal_session_1");
    expect(serialized).not.toContain("internal");
  });

  it("rejects duplicate options and mismatched trusted proposals", () => {
    const requirement = commandRequirement({});
    const duplicate = {
      ...requirement,
      decisionOptions: [
        requirement.decisionOptions[0],
        requirement.decisionOptions[0],
      ],
    } as unknown as ApprovalRequirement<"commandExecution">;

    expect(() =>
      createApprovalRequest({
        id: "request_1",
        requirement: duplicate,
        createdAt: "2026-07-15T00:00:00.000Z",
      }),
    ).toThrowError(expect.objectContaining({
      code: "approval_request_duplicate_option",
    }));

    const missingProposal = {
      ...requirement,
      trustedProposals: [],
    } as ApprovalRequirement<"commandExecution">;
    expect(() =>
      createApprovalRequest({
        id: "request_2",
        requirement: missingProposal,
        createdAt: "2026-07-15T00:00:00.000Z",
      }),
    ).toThrowError(ApprovalContractError);
  });

  it("gives user and automatic reviewers the same safe input contract", async () => {
    const request = projectApprovalReviewRequest(
      createApprovalRequest({
        id: "request_1",
        requirement: commandRequirement({}),
        createdAt: "2026-07-15T00:00:00.000Z",
      }),
    );
    const reviewContext = snapshotApprovalReviewContext({
      workspaceTrustState: "trusted",
      ruleOutcome: "prompt",
      currentAuthority: {
        fileSystemRead: true,
        fileSystemWrite: false,
        network: false,
      },
      annotations: { source: "test" },
    });
    const input: ApprovalReviewInput = {
      request,
      pendingVersion: 1,
      context: reviewContext,
    };
    const userReviewer = new FakeReviewer("user_submission");
    const autoReviewer = new FakeReviewer("auto_submission");

    await userReviewer.review(input, interruptionContext());
    await autoReviewer.review(input, interruptionContext());

    expect(userReviewer.inputs).toEqual([input]);
    expect(autoReviewer.inputs).toEqual([input]);
  });
});

class FakeReviewer implements ApprovalReviewerPort {
  readonly inputs: ApprovalReviewInput[] = [];

  constructor(private readonly submissionId: string) {}

  async review(
    input: ApprovalReviewInput,
    _context: InvocationInterruptionContext,
  ): Promise<ApprovalReviewOutcome> {
    this.inputs.push(input);
    return {
      status: "decided",
      submission: {
        submissionId: this.submissionId,
        runId: input.request.runId,
        requestId: input.request.id,
        pendingVersion: input.pendingVersion,
        optionId: "decline",
        grantedPermissions: null,
        reason: "Not now.",
      },
      rationale: null,
    };
  }
}

function commandRequirement(metadata: Record<string, unknown>): ApprovalRequirement<"commandExecution"> {
  return {
    category: "commandExecution",
    subject: {
      runId: "run_1",
      actionId: "action_1",
      actionFingerprint: "sha256:command",
      environmentId: "portable",
      applicabilityKeys: [
        { category: "commandExecution", value: "command:pnpm-test" },
      ],
    },
    reason: "Run the test suite.",
    payload: {
      command: ["pnpm", "test", "--token", "token-secret"],
      safeCommandDisplay: "pnpm test",
      cwd: "/work/repo",
      cwdDisplay: "workspace",
      environmentId: "portable",
      commandActions: [{ kind: "process", summary: "Run tests" }],
      additionalPermissions: null,
    },
    decisionOptions: [
      {
        id: "accept_session",
        kind: "acceptForSession",
        scope: "session",
        label: "Allow for session",
        description: null,
        trustedProposalRef: "proposal_session_1",
        metadata: {},
      },
      {
        id: "decline",
        kind: "decline",
        scope: null,
        label: "Decline",
        description: null,
        trustedProposalRef: null,
        metadata: {},
      },
    ],
    trustedProposals: [
      {
        kind: "session_authority",
        ref: "proposal_session_1",
        proposal: {
          proposalRef: "proposal_session_1",
          context: {
            hostSessionId: "session_1",
            authorityContextKey: "context_1",
            workspaceId: "workspace_1",
            identityId: "identity_1",
            environmentId: "portable",
          },
          category: "commandExecution",
          applicabilityKeys: [
            { category: "commandExecution", value: "command:pnpm-test" },
          ],
          defaultGrantedPermissions: null,
        },
      },
    ],
    deadlineAt: "2026-07-15T00:05:00.000Z",
    metadata,
  };
}

function interruptionContext(): InvocationInterruptionContext {
  return { signal: new AbortController().signal, interruption: null };
}

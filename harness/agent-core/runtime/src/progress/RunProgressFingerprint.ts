import type { AgentRevisionRef } from "@agent-anything/agent-core/agent";
import { createCanonicalSha256Digest } from "@agent-anything/canonical-action/subject";
import type { ArtifactRef } from "@agent-anything/agent-core/run";
import type { EvidenceRef } from "@agent-anything/context/evidence";
import type { OperationResult } from "@agent-anything/operation-catalog/result";
import type { ToolResult } from "@agent-anything/tools/result";
import type { VerificationRunnerProjection } from "@agent-anything/verification/projection";
import type { PlanUpdateOutcome } from "../plan/index.js";
import type {
  PendingRunSubjectProjection,
  RunSteeringApplication,
} from "../run/index.js";
import type {
  RunProgressBasis,
  RunProgressBasisProjection,
  RunProgressFactKind,
  RunProgressFactRef,
  RunProgressFactStrength,
  RunProgressOwnerOutcome,
  RunProgressSemanticFact,
} from "./RunProgress.js";

export type RunProgressCommittedFactInput =
  | {
      readonly kind: "controller_turn";
      readonly status: "decided" | "failed" | "interrupted";
      readonly decisionKind: "advance" | "propose_completion" | "propose_stop" | null;
      readonly failureOwner: string | null;
      readonly failureCode: string | null;
    }
  | {
      readonly kind: "run_action";
      readonly actionKind: "state_transition" | "operation" | "tool" | "interaction";
      readonly requestOrigin: string | null;
    }
  | { readonly kind: "plan_update"; readonly result: PlanUpdateOutcome }
  | {
      readonly kind: "active_agent";
      readonly previousAgent: AgentRevisionRef;
      readonly activeAgent: AgentRevisionRef;
    }
  | { readonly kind: "steering"; readonly steering: RunSteeringApplication }
  | {
      readonly kind: "operation_result";
      readonly result: OperationResult;
      readonly toolResult: ToolResult | null;
      readonly ownerOutcome: RunProgressOwnerOutcome | null;
    }
  | {
      readonly kind: "operation_rejected";
      readonly owner: string;
      readonly code: string;
    }
  | { readonly kind: "tool_rejected"; readonly code: string }
  | {
      readonly kind: "interaction_settlement";
      readonly owner: string;
      readonly status: "resolved" | "expired" | "cancelled" | "invalidated" | "failed";
      readonly contentDigest: string | null;
      readonly lowerRefs: readonly RunProgressFactRef[];
      readonly toolResult: ToolResult | null;
    }
  | {
      readonly kind: "descendant_settlement";
      readonly status: "succeeded" | "partial" | "failed" | "unavailable" | "denied" | "cancelled" | "timed_out" | "invalid" | "unknown_effect";
      readonly failureOwner: string | null;
      readonly failureCode: string | null;
      readonly lowerRefs: readonly RunProgressFactRef[];
      readonly toolResult: ToolResult;
    }
  | { readonly kind: "verification_feedback"; readonly verification: VerificationRunnerProjection }
  | { readonly kind: "evidence_ref"; readonly ref: EvidenceRef }
  | { readonly kind: "artifact_ref"; readonly ref: ArtifactRef }
  | { readonly kind: "required_pending"; readonly pending: PendingRunSubjectProjection };

export async function createRunProgressBasis(
  projection: RunProgressBasisProjection,
): Promise<RunProgressBasis> {
  const snapshot = deepFreeze({
    runId: token(projection.runId, "RunProgressBasis.runId"),
    taskId: token(projection.taskId, "RunProgressBasis.taskId"),
    activeAgent: agent(projection.activeAgent),
    workspaceFingerprint: nullableFingerprint(projection.workspaceFingerprint),
    toolSelectionRevision: token(
      projection.toolSelectionRevision,
      "RunProgressBasis.toolSelectionRevision",
    ),
    permissionFingerprint: fingerprint(
      projection.permissionFingerprint,
      "RunProgressBasis.permissionFingerprint",
    ),
    steeringFingerprint: nullableFingerprint(projection.steeringFingerprint),
    verificationSnapshotRevision: nonNegative(
      projection.verificationSnapshotRevision,
      "RunProgressBasis.verificationSnapshotRevision",
    ),
  });
  return deepFreeze({
    projection: snapshot,
    fingerprint: await createCanonicalSha256Digest(
      "agent-anything.run-progress-basis.v1",
      snapshot,
    ),
  });
}

export async function createRunProgressSemanticFacts(
  input: RunProgressCommittedFactInput,
): Promise<readonly RunProgressSemanticFact[]> {
  switch (input.kind) {
    case "controller_turn":
      return one(input.kind, "agent-runtime", null, null, "activity", {
        status: input.status,
        decisionKind: input.decisionKind,
        failureOwner: input.failureOwner,
        failureCode: input.failureCode,
      });
    case "run_action":
      return one(input.kind, "agent-runtime", null, null, "activity", {
        actionKind: input.actionKind,
        requestOrigin: input.requestOrigin,
      });
    case "plan_update":
      return one(input.kind, "agent-runtime", null, null, "declaration", {
        status: input.result.status,
        transition: input.result.status === "applied" ? input.result.transition : null,
        code: input.result.status === "rejected" ? input.result.code : null,
      });
    case "active_agent":
      return one(
        input.kind,
        "agent-runtime",
        input.activeAgent.id,
        input.activeAgent.revision,
        "strong",
        { previousAgent: agent(input.previousAgent), activeAgent: agent(input.activeAgent) },
      );
    case "steering":
      return one(input.kind, "agent-runtime", null, null, "declaration", {
        status: input.steering.status,
        reasonCode: input.steering.reasonCode,
        origin: input.steering.command.attribution.origin,
      });
    case "operation_result": {
      const operation = input.result.binding.operation;
      const lowerRefs = semanticLowerRefs(input.result.lowerRefs);
      const tool = normalizeToolResult(input.toolResult);
      const ownerOutcome = normalizeOwnerOutcome(input.ownerOutcome);
      const hasOwnerOutcome = input.result.failure !== null ||
        ownerOutcome?.disposition === "state_changed" ||
        ownerOutcome?.disposition === "new_information" ||
        ownerOutcome?.disposition === "work_settled";
      return one(
        input.kind,
        ownerOutcome?.owner ?? input.result.semanticOwner,
        ownerOutcome?.subjectId ?? `${operation.operation.namespace}.${operation.operation.name}`,
        ownerOutcome?.revision ?? operation.revision,
        hasOwnerOutcome ? "strong" : "activity",
        {
          operation,
          bindingRevision: input.result.binding.revision,
          status: input.result.status,
          failure: normalizeFailure(input.result.failure),
          lowerRefs,
          tool,
          ownerOutcome,
        },
      );
    }
    case "operation_rejected":
      return one(input.kind, input.owner, null, null, "strong", { code: input.code });
    case "tool_rejected":
      return one(input.kind, "tools", null, null, "strong", { code: input.code });
    case "interaction_settlement":
      return one(input.kind, input.owner, null, null, "strong", {
        status: input.status,
        contentDigest: input.contentDigest,
        lowerRefs: normalizeFactRefs(input.lowerRefs),
        tool: normalizeToolResult(input.toolResult),
      });
    case "descendant_settlement":
      return one(input.kind, "agent-runtime", null, null, "strong", {
        status: input.status,
        failureOwner: input.failureOwner,
        failureCode: input.failureCode,
        lowerRefs: normalizeFactRefs(input.lowerRefs),
        tool: normalizeToolResult(input.toolResult),
      });
    case "verification_feedback": {
      const verification = input.verification;
      const feedback = await one(
        input.kind,
        "verification",
        verification.snapshot.runId,
        null,
        "strong",
        {
          feedback: verification.feedback.map((item) => ({
            requirement: item.requirement,
            state: item.state,
            code: item.code,
            recoveryNeeded: item.recoveryNeeded,
          })),
          pendingAttempts: verification.pendingAttempts.map((item) => ({ ordinal: item.ordinal })),
        },
      );
      if (verification.gate === null) return feedback;
      return Object.freeze([
        ...feedback,
        ...(await one(
          "completion_gate",
          "verification",
          verification.snapshot.runId,
          null,
          "strong",
          { gateRecorded: true },
        )),
      ]);
    }
    case "evidence_ref":
      return one(input.kind, "context", input.ref, null, "strong", { ref: input.ref });
    case "artifact_ref":
      return one(input.kind, "agent-core", input.ref, null, "strong", { ref: input.ref });
    case "required_pending":
      return one(
        input.kind,
        input.pending.owner,
        input.pending.subjectId,
        input.pending.revision,
        "activity",
        {
          kind: input.pending.kind,
          required: input.pending.required,
          owner: input.pending.owner,
          revision: input.pending.revision,
        },
      );
    default: {
      const unsupported = input as { readonly kind?: unknown };
      return one(
        "unsupported_committed_fact",
        "agent-runtime",
        null,
        null,
        "activity",
        {
          sourceKind: typeof unsupported.kind === "string"
            ? unsupported.kind
            : "invalid",
          code: "progress_fact_kind_unsupported",
        },
      );
    }
  }
}

async function one(
  kind: RunProgressFactKind,
  owner: string,
  subjectId: string | null,
  revision: string | null,
  strength: RunProgressFactStrength,
  semanticValue: unknown,
): Promise<readonly RunProgressSemanticFact[]> {
  const ref = deepFreeze({
    kind,
    owner: token(owner, "RunProgressFact.owner"),
    subjectId,
    revision,
  });
  return Object.freeze([deepFreeze({
    ref,
    strength,
    fingerprint: await createCanonicalSha256Digest(
      `agent-anything.run-progress-fact.${kind}.v1`,
      { owner: ref.owner, semanticValue },
    ),
  })]);
}

function normalizeToolResult(input: ToolResult | null) {
  if (input === null) return null;
  return {
    status: input.status,
    settlement: {
      owner: input.settlement.owner,
      kind: input.settlement.kind,
      revision: input.settlement.revision,
    },
    errorCode: input.status === "succeeded" ? null : input.error.code,
  };
}

function normalizeOwnerOutcome(input: RunProgressOwnerOutcome | null) {
  if (input === null) return null;
  if (![
    "state_changed",
    "new_information",
    "work_settled",
    "no_change",
  ].includes(input.disposition)) {
    throw new TypeError("RunProgressOwnerOutcome.disposition is unsupported.");
  }
  return {
    owner: token(input.owner, "RunProgressOwnerOutcome.owner"),
    subjectId: input.subjectId,
    revision: input.revision,
    disposition: input.disposition,
    fingerprint: fingerprint(input.fingerprint, "RunProgressOwnerOutcome.fingerprint"),
  };
}

function normalizeFailure(input: OperationResult["failure"]) {
  return input === null
    ? null
    : { owner: input.owner, code: input.code, retryable: input.retryable };
}

function semanticLowerRefs(
  refs: OperationResult["lowerRefs"],
): readonly { readonly owner: string; readonly kind: string; readonly revision: string }[] {
  return Object.freeze(refs
    .filter((ref): ref is typeof ref & { readonly revision: string } => ref.revision !== null)
    .map((ref) => ({ owner: ref.owner, kind: ref.kind, revision: ref.revision }))
    .sort(compareRefs));
}

function normalizeFactRefs(refs: readonly RunProgressFactRef[]) {
  return Object.freeze(refs.map((ref) => ({
    kind: ref.kind,
    owner: ref.owner,
    revision: ref.revision,
  })).sort(compareRefs));
}

function compareRefs(
  left: { readonly owner: string; readonly kind: string; readonly revision: string | null },
  right: { readonly owner: string; readonly kind: string; readonly revision: string | null },
): number {
  return `${left.owner}:${left.kind}:${left.revision ?? ""}`.localeCompare(
    `${right.owner}:${right.kind}:${right.revision ?? ""}`,
  );
}

function agent(input: AgentRevisionRef): AgentRevisionRef {
  return Object.freeze({
    id: token(input.id, "AgentRevisionRef.id"),
    revision: token(input.revision, "AgentRevisionRef.revision"),
  });
}

function token(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${field} must be a canonical token.`);
  }
  return value;
}

function fingerprint(value: unknown, field: string): string {
  const result = token(value, field);
  if (!/^sha256:[0-9a-f]{64}$/.test(result)) {
    throw new TypeError(`${field} must be a canonical SHA-256 fingerprint.`);
  }
  return result;
}

function nullableFingerprint(value: unknown): string | null {
  return value === null ? null : fingerprint(value, "RunProgressBasis fingerprint");
}

function nonNegative(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer.`);
  }
  return value as number;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

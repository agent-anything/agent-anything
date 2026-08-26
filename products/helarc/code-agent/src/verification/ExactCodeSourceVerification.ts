import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import type { WorkspaceSelection } from "@agent-anything/workspace/selection";
import {
  createVerificationFailure,
  type VerificationOwnerRef,
} from "@agent-anything/verification/definition";
import type {
  VerificationPureCheckEvaluatorPort,
} from "@agent-anything/verification/execution";
import type {
  VerificationSubjectAdapter,
  VerificationSubjectAdapterRef,
  VerificationSubjectFreshnessPort,
  VerificationSubjectSnapshot,
  VerificationSubjectSnapshotRef,
} from "@agent-anything/verification/subject";
import type {
  CodeSourceCaptureResult,
  CodeSourcePort,
  CodeSourceSnapshot,
} from "../source/index.js";

export const EXACT_CODE_SOURCE_SUBJECT_KIND = "code_source_exact_state";
export const EXACT_CODE_SOURCE_CHECK_FAMILY = "exact_target_state";

export const EXACT_CODE_SOURCE_EVALUATOR_REF: VerificationOwnerRef = Object.freeze({
  owner: "helarc.code-workspace",
  kind: "pure_check_evaluator",
  id: "exact-target-state",
  revision: "1",
});

export interface ExactCodeSourceVerificationTarget {
  readonly ref: VerificationOwnerRef;
  readonly expected: CodeSourceSnapshot;
  readonly maxContentBytes: number;
}

export interface ExactCodeSourceVerificationContribution {
  readonly target: ExactCodeSourceVerificationTarget;
  readonly adapter: VerificationSubjectAdapter;
  readonly freshness: VerificationSubjectFreshnessPort;
  readonly evaluator: VerificationPureCheckEvaluatorPort;
  readonly adapterRef: VerificationSubjectAdapterRef;
  readonly configurationRef: VerificationOwnerRef;
  readonly expectedFingerprint: string;
}

interface CapturedSourceState {
  readonly subject: VerificationSubjectSnapshot;
  readonly source: CodeSourceSnapshot;
}

export function createExactCodeSourceVerificationContribution(input: {
  readonly target: ExactCodeSourceVerificationTarget;
  readonly source: CodeSourcePort;
  readonly workspace: WorkspaceSelection;
}): ExactCodeSourceVerificationContribution {
  assertTarget(input.target);
  const target = deepFreeze(structuredClone(input.target));
  const adapterRef: VerificationSubjectAdapterRef = Object.freeze({
    owner: "helarc.code-workspace",
    kind: "subject_adapter",
    id: `exact-source-${target.ref.id}`,
    revision: target.ref.revision,
  });
  const configurationRef: VerificationOwnerRef = Object.freeze({
    owner: "helarc.code-workspace",
    kind: "target_state_configuration",
    id: target.ref.id,
    revision: target.ref.revision,
  });
  const expectedFingerprint = sourceFingerprint(target.expected);
  const snapshots = new Map<string, CapturedSourceState>();

  const capture = async (
    runId: string,
    requestedSource: VerificationOwnerRef,
    interruption: InvocationInterruptionContext,
  ) => {
    if (interruption.signal.aborted) {
      return failureResult("verification_subject_capture_cancelled", "Source-state capture was cancelled.", false);
    }
    const result = await input.source.capture({
      workspace: input.workspace,
      rootName: target.expected.target.rootName,
      path: target.expected.target.path,
      operation: "observe",
      maxContentBytes: target.maxContentBytes,
    });
    if (result.status !== "captured") return sourceFailure(result);
    const subject = createSubjectSnapshot(
      runId,
      result.snapshot,
      requestedSource,
      adapterRef,
    );
    snapshots.set(refKey(subject.ref), Object.freeze({ subject, source: result.snapshot }));
    return Object.freeze({ status: "captured" as const, snapshot: subject });
  };

  const adapter: VerificationSubjectAdapter = Object.freeze({
    ref: adapterRef,
    subjectKinds: Object.freeze([EXACT_CODE_SOURCE_SUBJECT_KIND]),
    capture(request, interruption) {
      return capture(request.run.id, request.requestedSource, interruption);
    },
    async rehydrate(ref, interruption) {
      const retained = snapshots.get(refKey(ref));
      if (retained === undefined) {
        return failureResult("verification_subject_snapshot_unavailable", "Source-state snapshot is unavailable.", false);
      }
      if (interruption.signal.aborted) {
        return failureResult("verification_subject_rehydration_cancelled", "Source-state rehydration was cancelled.", false);
      }
      const result = await input.source.rehydrate({
        workspace: input.workspace,
        expected: retained.source,
        maxContentBytes: target.maxContentBytes,
      });
      if (result.status === "matched") {
        return Object.freeze({ status: "captured" as const, snapshot: retained.subject });
      }
      if (result.status === "changed") {
        return failureResult("verification_subject_snapshot_stale", "Source state no longer matches the requested snapshot.", false);
      }
      return sourceFailure(result);
    },
  } satisfies VerificationSubjectAdapter);

  const freshness: VerificationSubjectFreshnessPort = Object.freeze({
    async checkFreshness(ref, interruption) {
      const retained = snapshots.get(refKey(ref));
      if (retained === undefined) {
        return Object.freeze({
          status: "unavailable" as const,
          snapshot: ref,
          failure: verificationFailure(
            "verification_subject_snapshot_unavailable",
            "Source-state snapshot is unavailable.",
            false,
          ),
        });
      }
      if (interruption.signal.aborted) {
        return Object.freeze({
          status: "failed" as const,
          snapshot: ref,
          failure: verificationFailure(
            "verification_subject_freshness_cancelled",
            "Source-state freshness check was cancelled.",
            false,
          ),
        });
      }
      const result = await input.source.rehydrate({
        workspace: input.workspace,
        expected: retained.source,
        maxContentBytes: target.maxContentBytes,
      });
      if (result.status === "matched") {
        return Object.freeze({ status: "current" as const, snapshot: ref });
      }
      if (result.status === "changed") {
        const current = createSubjectSnapshot(
          retained.subject.run.id,
          result.snapshot,
          target.ref,
          adapterRef,
        );
        snapshots.set(refKey(current.ref), Object.freeze({ subject: current, source: result.snapshot }));
        return Object.freeze({
          status: "stale" as const,
          snapshot: ref,
          current: current.ref,
          change: target.ref,
        });
      }
      return Object.freeze({
        status: result.status,
        snapshot: ref,
        failure: verificationFailure(
          result.status === "invalid"
            ? "verification_subject_freshness_invalid"
            : result.status === "unavailable"
              ? "verification_subject_freshness_unavailable"
              : "verification_subject_freshness_failed",
          result.message,
          result.status === "unavailable" || result.status === "failed",
        ),
      });
    },
  } satisfies VerificationSubjectFreshnessPort);

  const evaluator: VerificationPureCheckEvaluatorPort = Object.freeze({
    async evaluate(check, interruption) {
      if (interruption.signal.aborted) {
        return Object.freeze({
          status: "cancelled" as const,
          findings: Object.freeze([]),
          coverage: Object.freeze({ ratio: 0, basis: "target-state check cancelled" }),
          costUnits: null,
          limitations: Object.freeze([]),
          failure: verificationFailure(
            "verification_target_state_check_cancelled",
            "Exact target-state check was cancelled.",
            false,
          ),
        });
      }
      if (!sameOwnerRef(check.attempt.configuration, configurationRef)) {
        return Object.freeze({
          status: "invalid" as const,
          findings: Object.freeze([]),
          coverage: Object.freeze({ ratio: 0, basis: "target-state configuration mismatch" }),
          costUnits: null,
          limitations: Object.freeze([]),
          failure: verificationFailure(
            "verification_target_state_configuration_invalid",
            "Exact target-state configuration does not match the admitted target.",
            false,
          ),
        });
      }
      const matches = check.subject.fingerprint.value === expectedFingerprint;
      return Object.freeze({
        status: "completed" as const,
        findings: Object.freeze([Object.freeze({
          owner: "helarc.code-workspace",
          claim: check.requirement.claim,
          polarity: matches ? "supports" as const : "contradicts" as const,
          severity: matches ? "info" as const : "error" as const,
          sourceRefs: Object.freeze([configurationRef]),
          limitations: Object.freeze([]),
        })]),
        coverage: Object.freeze({ ratio: 1, basis: "exact owner source-state comparison" }),
        costUnits: null,
        limitations: Object.freeze([]),
        failure: null,
      });
    },
  } satisfies VerificationPureCheckEvaluatorPort);

  return Object.freeze({
    target,
    adapter,
    freshness,
    evaluator,
    adapterRef,
    configurationRef,
    expectedFingerprint,
  });
}

function createSubjectSnapshot(
  runId: string,
  source: CodeSourceSnapshot,
  requestedSource: VerificationOwnerRef,
  adapter: VerificationSubjectAdapterRef,
): VerificationSubjectSnapshot {
  const fingerprint = sourceFingerprint(source);
  return deepFreeze({
    ref: {
      id: `code-source-${source.target.workspaceId}-${source.target.rootName}-${source.target.path.replace(/[^A-Za-z0-9._:-]/g, "_")}`,
      revision: fingerprint,
    },
    run: { id: runId },
    owner: "helarc.code-workspace",
    kind: EXACT_CODE_SOURCE_SUBJECT_KIND,
    stateRefs: [requestedSource],
    capturedAt: source.capturedAt,
    environment: null,
    scope: [
      { key: "workspace", value: source.target.workspaceId },
      { key: "root", value: source.target.rootName },
      { key: "path", value: source.target.path },
    ],
    coverage: { kind: "complete" as const, ratio: 1 },
    fingerprint: {
      algorithm: source.contentRef?.algorithm ?? "exact-absence",
      value: fingerprint,
      basis: "Code Workspace exact source state",
    },
    sensitivity: "internal" as const,
    audiences: ["verification"],
    adapter,
  });
}

function sourceFingerprint(source: CodeSourceSnapshot): string {
  return source.contentRef?.digest ?? "absent";
}

function sourceFailure(result: Exclude<CodeSourceCaptureResult, { readonly status: "captured" }> | {
  readonly status: "invalid" | "unavailable" | "failed";
  readonly code: string;
  readonly message: string;
}) {
  return failureResult(
    result.status === "invalid"
      ? "verification_subject_capture_invalid"
      : result.status === "unavailable"
        ? "verification_subject_capture_unavailable"
        : "verification_subject_capture_failed",
    result.message,
    result.status !== "invalid",
    result.status,
  );
}

function failureResult(
  code: `verification_${string}`,
  message: string,
  retryable: boolean,
  status: "invalid" | "unavailable" | "failed" = "failed",
) {
  return Object.freeze({
    status,
    failure: verificationFailure(code, message, retryable),
  });
}

function verificationFailure(
  code: `verification_${string}`,
  message: string,
  retryable: boolean,
) {
  return createVerificationFailure({
    code,
    stage: "subject",
    message,
    retryable,
    cause: null,
  });
}

function sameOwnerRef(left: VerificationOwnerRef | null, right: VerificationOwnerRef): boolean {
  return left !== null && left.owner === right.owner && left.kind === right.kind &&
    left.id === right.id && left.revision === right.revision;
}

function refKey(ref: VerificationSubjectSnapshotRef): string {
  return `${ref.id}@${ref.revision}`;
}

function assertTarget(target: ExactCodeSourceVerificationTarget): void {
  if (!Number.isSafeInteger(target.maxContentBytes) || target.maxContentBytes < 1) {
    throw new TypeError("Exact source target maxContentBytes must be positive.");
  }
  if (target.ref.owner !== "helarc.code-workspace") {
    throw new TypeError("Exact source target must be owned by Helarc Code Workspace.");
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

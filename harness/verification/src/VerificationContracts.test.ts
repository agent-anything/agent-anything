import { describe, expect, it } from "vitest";
import {
  createVerificationFailure,
  materializeVerificationProfile,
  snapshotVerificationProfile,
  snapshotVerificationRequirement,
  snapshotVerificationSpecification,
  type VerificationOwnerRef,
  type VerificationRequirement,
} from "./definition/index.js";
import { snapshotVerificationSubjectSnapshot } from "./subject/index.js";
import { snapshotCheckDefinition, snapshotCheckResult } from "./execution/index.js";
import { snapshotVerificationEvidence } from "./evidence/index.js";
import {
  snapshotVerificationAssessment,
  snapshotVerificationCurrentSnapshot,
} from "./assessment/index.js";
import {
  snapshotCompletionGateDecision,
  snapshotCompletionGateInput,
  type CompletionGateDecision,
  type CompletionGateInput,
} from "./completion/index.js";
import { snapshotVerificationHostProjection } from "./projection/index.js";
import { snapshotVerificationPersistenceReceipt } from "./persistence/index.js";

const NOW = "2026-08-18T00:00:00.000Z";

describe("Verification Contract foundation", () => {
  it("keeps a reusable profile Run-neutral and materializes exact Run records once", () => {
    const { specification: _specification, createdAt: _createdAt, ...template } = requirementInput();
    const profile = snapshotVerificationProfile({
      ref: owner("profile"),
      specification: ref("profile-specification"),
      source: source("task_contract"),
      admittedBy: owner("profile-admission"),
      requirements: [template],
    });
    const materialized = materializeVerificationProfile({
      profile,
      run: { id: "run-1" },
      createdAt: NOW,
    });

    expect("run" in profile).toBe(false);
    expect(materialized.specification.run.id).toBe("run-1");
    expect(materialized.requirements[0]?.specification).toEqual(profile.specification);
    expect(Object.isFrozen(materialized.requirements)).toBe(true);
  });

  it("admits only trusted immutable Specification and Requirement shapes", () => {
    const requirement = snapshotVerificationRequirement(requirementInput());
    const specification = snapshotVerificationSpecification({
      ref: ref("specification"),
      run: { id: "run-1" },
      source: source("task_contract"),
      requirementRefs: [requirement.ref],
      supersedes: null,
      admittedBy: owner("verification-admission"),
      createdAt: NOW,
    });

    expect(Object.isFrozen(requirement.completionHandling)).toBe(true);
    expect(Object.isFrozen(specification.requirementRefs)).toBe(true);
    expect(() => snapshotVerificationSpecification({
      ...specification,
      source: { ...specification.source, sourceKind: "model" as never },
    })).toThrow(/sourceKind/);
    expect(() => snapshotVerificationRequirement({
      ...requirement,
      completionHandling: { ...requirement.completionHandling, unknown: "continue" } as never,
    })).toThrow(/unsupported field/);
  });

  it("preserves exact owner-attributed Subject identity and rejects incomplete coverage", () => {
    const snapshot = snapshotVerificationSubjectSnapshot({
      ref: ref("subject"),
      run: { id: "run-1" },
      owner: "code-workspace",
      kind: "workspace_source",
      stateRefs: [owner("workspace-state")],
      capturedAt: NOW,
      environment: owner("environment"),
      scope: [{ key: "workspace", value: "workspace-1" }],
      coverage: { kind: "complete", ratio: 1 },
      fingerprint: { algorithm: "sha256", value: "abc123", basis: "workspace revision" },
      sensitivity: "internal",
      audiences: ["runner"],
      adapter: owner("subject-adapter"),
    });

    expect(snapshot.owner).toBe("code-workspace");
    expect(Object.isFrozen(snapshot.stateRefs)).toBe(true);
    expect(() => snapshotVerificationSubjectSnapshot({
      ...snapshot,
      coverage: { kind: "complete", ratio: 0.9 },
    })).toThrow(/ratio 1/);
  });

  it("keeps Check completion separate from findings and Requirement satisfaction", () => {
    const definition = snapshotCheckDefinition({
      ref: ref("check-definition"),
      owner: "helarc",
      family: "command_verification",
      requirementKinds: ["test"],
      subjectKinds: ["workspace_source"],
      acceptedOrigins: ["controller", "trusted_automatic"],
      effect: { kind: "pure", evaluator: owner("pure-evaluator"), operationBinding: null },
      resultInterpreter: owner("result-interpreter"),
      environmentNeeds: [],
      maximumDurationMs: 30_000,
      maximumAttempts: 2,
      maximumCostUnits: null,
      retryPolicy: "safe",
      evidencePolicyRevision: "evidence-v1",
    });
    const result = snapshotCheckResult({
      ref: ref("check-result"),
      attempt: { id: "attempt-1", ordinal: 1 },
      status: "completed",
      findings: [],
      operationResult: null,
      actionSettlement: null,
      coverage: { ratio: 1, basis: "complete execution" },
      costUnits: null,
      startedAt: NOW,
      finishedAt: NOW,
      limitations: [],
      failure: null,
    });

    expect(definition.effect.kind).toBe("pure");
    expect(result.status).toBe("completed");
    expect("verdict" in result).toBe(false);
    expect(() => snapshotCheckResult({
      ...result,
      status: "partial",
      failure: failure(),
    })).toThrow(/usable Finding/);
    expect(() => snapshotCheckResult({
      ...result,
      status: "unknown" as never,
    })).toThrow(/status/);
  });

  it("accepts every Check result status only with its required payload", () => {
    const unsuccessful = [
      "invalid", "unavailable", "denied", "cancelled", "timed_out", "failed",
    ] as const;
    for (const status of unsuccessful) {
      expect(snapshotCheckResult({
        ref: ref(`result-${status}`),
        attempt: { id: "attempt-1", ordinal: 1 },
        status,
        findings: [],
        operationResult: null,
        actionSettlement: null,
        coverage: { ratio: 0, basis: "no usable result" },
        costUnits: null,
        startedAt: NOW,
        finishedAt: NOW,
        limitations: [],
        failure: failure(),
      }).status).toBe(status);
    }
    expect(snapshotCheckResult({
      ref: ref("result-partial"),
      attempt: { id: "attempt-1", ordinal: 1 },
      status: "partial",
      findings: [{
        ref: ref("finding"),
        owner: "verification",
        claim: "Some checks completed.",
        polarity: "limits",
        severity: "warning",
        sourceRefs: [owner("partial-source")],
        limitations: ["coverage_incomplete"],
      }],
      operationResult: null,
      actionSettlement: null,
      coverage: { ratio: 0.5, basis: "partial execution" },
      costUnits: null,
      startedAt: NOW,
      finishedAt: NOW,
      limitations: ["coverage_incomplete"],
      failure: failure(),
    }).status).toBe("partial");
  });

  it("links generic Context Evidence without treating it as Verification Evidence", () => {
    const evidence = snapshotVerificationEvidence({
      ref: ref("verification-evidence"),
      requirement: ref("requirement"),
      subject: ref("subject"),
      source: { kind: "context_evidence", evidence: "context-evidence-1" },
      admission: { status: "admitted", failure: null },
      coverage: { ratio: 1, basis: "complete check result" },
      sensitivity: "internal",
      audiences: ["verification"],
      limitations: [],
      createdAt: NOW,
    });

    expect(evidence.source).toEqual({ kind: "context_evidence", evidence: "context-evidence-1" });
    expect(evidence.ref.id).not.toBe("context-evidence-1");
  });

  it("keeps immutable Assessment verdict separate from current Requirement state", () => {
    const assessment = snapshotVerificationAssessment({
      ref: ref("assessment"),
      requirement: ref("requirement"),
      subject: ref("subject"),
      method: { owner: "verification", kind: "assessment_method", id: "method", revision: "v1" },
      evidenceRefs: [ref("verification-evidence")],
      coverage: { ratio: 1, basis: "complete admitted evidence" },
      verdict: "satisfied",
      basis: "Current evidence satisfies the claim.",
      limitations: [],
      assessedAt: NOW,
    });
    const current = snapshotVerificationCurrentSnapshot({
      ref: { runId: "run-1", revision: 1 },
      run: { id: "run-1" },
      specification: ref("specification"),
      requirementStates: [{
        requirement: ref("requirement"),
        status: "stale",
        subject: ref("subject"),
        assessment: assessment.ref,
        pendingAttempts: [],
        limitations: ["subject_changed"],
        updatedAt: NOW,
      }],
      createdAt: NOW,
    });

    expect(assessment.verdict).toBe("satisfied");
    expect(current.requirementStates[0]?.status).toBe("stale");
  });

  it("keeps blocked_unassessed distinct and requires Failures for invalid or failed gates", () => {
    const input = snapshotCompletionGateInput(completionInput());
    const blocked = snapshotCompletionGateDecision({
      invocation: input.invocation,
      verificationSnapshot: input.verificationSnapshot,
      status: "blocked_unassessed",
      disposition: "continue",
      reasons: [{
        owner: "verification",
        code: "verification_requirement_unassessed",
        message: "A mandatory Requirement is unassessed.",
        requirement: ref("requirement"),
      }],
      failure: null,
      decidedAt: NOW,
    });

    expect(blocked.status).toBe("blocked_unassessed");
    expect(blocked.status).not.toBe("blocked_pending");
    expect(() => snapshotCompletionGateDecision({
      invocation: input.invocation,
      verificationSnapshot: input.verificationSnapshot,
      status: "invalid",
      disposition: "fail",
      reasons: [],
      failure: null,
      decidedAt: NOW,
    } as unknown as CompletionGateDecision)).toThrow(/requires VerificationFailure/);
  });

  it("rejects package-generic Failure codes and unknown Completion input fields", () => {
    expect(() => createVerificationFailure({ ...failure(), code: "runtime_failed" as never })).toThrow(/verification_/);
    const input = completionInput();
    expect(() => snapshotCompletionGateInput({ ...input, metadata: {} } as unknown as CompletionGateInput))
      .toThrow(/unsupported field/);
  });

  it("keeps Host projections bounded and persistence receipts non-authoritative", () => {
    const projection = snapshotVerificationHostProjection({
      snapshot: { runId: "run-1", revision: 1 },
      counts: [{ state: "unassessed", count: 1 }],
      activeChecks: 0,
      gateStatus: "blocked_unassessed",
      safeReasons: ["A mandatory Requirement is unassessed."],
      updatedAt: NOW,
    });
    const receipt = snapshotVerificationPersistenceReceipt({
      storeOwner: "verification-store",
      recordKind: "assessment",
      recordId: "assessment-1",
      sequence: 1,
      storedAt: NOW,
    });

    expect(Object.isFrozen(projection.counts)).toBe(true);
    expect("evidence" in projection).toBe(false);
    expect("completionEligible" in receipt).toBe(false);
    expect(() => snapshotVerificationHostProjection({
      ...projection,
      rawEvidence: "not allowed",
    } as never)).toThrow(/unsupported field/);
  });
});

function requirementInput(): VerificationRequirement {
  return {
    ref: ref("requirement"),
    specification: ref("specification"),
    source: source("task_contract"),
    kind: "test",
    claim: "The current workspace passes the required verification.",
    purpose: "Protect successful completion.",
    necessity: "mandatory",
    subjectKinds: ["workspace_source"],
    checkFamilies: ["command_verification"],
    assessmentMethod: owner("assessment-method"),
    freshness: { required: true, maximumAgeMs: 60_000 },
    coverage: { kind: "complete", minimumRatio: 1 },
    evidence: {
      minimumAdmittedCount: 1,
      acceptedSourceKinds: ["check_result"],
      conflictingEvidence: "inconclusive",
    },
    limits: { maximumAttempts: 2, maximumDurationMs: 60_000, maximumCostUnits: null },
    disclosure: { sensitivity: "internal", audiences: ["runner", "host"] },
    completionHandling: {
      unassessed: "continue",
      pending: "wait",
      violated: "block",
      inconclusive: "block",
      stale: "continue",
    },
    createdAt: NOW,
  };
}

function completionInput(): CompletionGateInput {
  return {
    invocation: ref("gate"),
    run: { id: "run-1" },
    turn: { run: { id: "run-1" }, id: "turn-1", sequence: 1 },
    proposal: ref("proposal"),
    proposalOutputDigest: "sha256-output",
    outputContract: owner("output-contract"),
    specification: ref("specification"),
    verificationSnapshot: { runId: "run-1", revision: 1 },
    mandatoryStates: [{
      current: {
        requirement: ref("requirement"),
        status: "unassessed",
        subject: null,
        assessment: null,
        pendingAttempts: [],
        limitations: [],
        updatedAt: NOW,
      },
      disposition: "continue",
    }],
    pendingWork: [],
    conditions: [],
    lifecycle: { runRevision: 2, status: "running", cancellationRevision: 0, deadlineAt: null },
    policy: owner("gate-policy"),
    correlation: owner("gate-correlation"),
    requestedAt: NOW,
  };
}

function ref(id: string) {
  return { id, revision: "v1" };
}

function owner(id: string): VerificationOwnerRef {
  return { owner: "verification", kind: "record", id, revision: "v1" };
}

function source(sourceKind: "task_contract") {
  return { ...owner("trusted-source"), sourceKind };
}

function failure() {
  return createVerificationFailure({
    code: "verification_check_failed",
    stage: "check",
    message: "The check failed.",
    retryable: false,
    cause: owner("child-failure"),
  });
}

import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import type { RunRef } from "@agent-anything/agent-core/run";
import {
  measureContextPayload,
  snapshotContextContribution,
  type ContextContributionLimits,
} from "@agent-anything/context/contribution";
import {
  createVerificationFailure,
  snapshotVerificationRequirement,
  snapshotVerificationSpecification,
  type VerificationFailure,
  type VerificationOwnerRef,
  type VerificationRequirement,
  type VerificationRequirementRef,
} from "../definition/index.js";
import {
  snapshotVerificationSubjectSnapshot,
  type VerificationSubjectCaptureResult,
  type VerificationSubjectFreshnessOutcome,
  type VerificationSubjectSnapshot,
  type VerificationSubjectSnapshotRef,
} from "../subject/index.js";
import {
  snapshotVerificationAssessment,
  snapshotVerificationCurrentRequirementState,
  snapshotVerificationCurrentSnapshot,
  type VerificationAssessment,
  type VerificationCurrentRequirementState,
  type VerificationCurrentSnapshot,
} from "../assessment/index.js";
import {
  snapshotVerificationEvidence,
  type VerificationEvidence,
} from "../evidence/index.js";
import {
  snapshotCompletionGateDecision,
  type CompletionGateRecord,
} from "../completion/index.js";
import {
  snapshotVerificationPersistenceReceipt,
  type VerificationCurrentSnapshotStorePort,
  type VerificationPersistenceRecord,
  type VerificationRecordStorePort,
} from "../persistence/index.js";
import {
  snapshotVerificationEvaluationProjection,
  snapshotVerificationContextProjection,
  snapshotVerificationHostProjection,
  snapshotVerificationObservabilityProjection,
  snapshotVerificationRunnerProjection,
  type VerificationEvaluationProjection,
  type VerificationContextProjection,
  type VerificationHostProjection,
  type VerificationObservabilityProjection,
  type VerificationRunnerFeedback,
  type VerificationRunnerProjection,
  type VerificationStateCount,
} from "../projection/index.js";
import {
  snapshotCheckAttempt,
  snapshotCheckDefinition,
  snapshotCheckResult,
  type CheckAttempt,
  type CheckAttemptRef,
  type CheckDefinition,
  type CheckFinding,
  type CheckResult,
  type VerificationAssessmentRequest,
  type VerificationCheckDefinitionAdmission,
  type VerificationCheckInterpretation,
  type VerificationCheckRequest,
  type VerificationExecutionCloseRequest,
  type VerificationExecutionFactory,
  type VerificationExecutionFactoryInput,
  type VerificationExecutionPersistenceFailure,
  type VerificationExecutionPort,
  type VerificationGateRecordRequest,
  type VerificationLedgerSnapshot,
  type VerificationLowerCheckSettlement,
  type VerificationSettledOperationCheckRequest,
  type VerificationSpecificationAdmission,
  type VerificationSubjectCaptureRequest,
  type VerificationSubjectFreshnessRequest,
  type VerificationSubjectRehydrationRequest,
  type VerificationEvidenceAdmissionRequest,
} from "./VerificationExecution.js";
import type {
  VerificationAssessmentMethodResolverPort,
  VerificationCheckInterpreterResolverPort,
  VerificationClockPort,
  VerificationIdentityPort,
  VerificationOperationCheckResolverPort,
  VerificationPureCheckResolverPort,
  VerificationSubjectAdapterResolverPort,
  VerificationSubjectFreshnessResolverPort,
} from "./VerificationExecutionAdapters.js";
import { VerificationExecutionError } from "./VerificationExecutionError.js";

export interface VerificationExecutionDependencies {
  readonly clock: VerificationClockPort;
  readonly identities: VerificationIdentityPort;
  readonly subjectAdapters: VerificationSubjectAdapterResolverPort;
  readonly subjectFreshness: VerificationSubjectFreshnessResolverPort;
  readonly pureChecks: VerificationPureCheckResolverPort;
  readonly operationChecks: VerificationOperationCheckResolverPort;
  readonly interpreters: VerificationCheckInterpreterResolverPort;
  readonly assessmentMethods: VerificationAssessmentMethodResolverPort;
  readonly recordStore?: VerificationRecordStorePort;
  readonly currentSnapshotStore?: VerificationCurrentSnapshotStorePort;
}

export class VerificationExecution implements VerificationExecutionPort {
  private readonly run: RunRef;
  private readonly requirements = new Map<string, VerificationRequirement>();
  private readonly subjects = new Map<string, VerificationSubjectSnapshot>();
  private readonly definitions = new Map<string, CheckDefinition>();
  private readonly attempts = new Map<string, CheckAttempt>();
  private readonly results = new Map<string, CheckResult>();
  private readonly resultByAttempt = new Map<string, CheckResult>();
  private readonly retrySuccessorByAttempt = new Map<string, CheckAttemptRef>();
  private readonly lowerSettlements = new Map<string, VerificationLowerCheckSettlement>();
  private readonly evidenceRecords = new Map<string, VerificationEvidence>();
  private readonly assessments = new Map<string, VerificationAssessment>();
  private readonly gateRecords = new Map<string, CompletionGateRecord>();
  private readonly history: VerificationPersistenceRecord[] = [];
  private readonly persistenceFailures: VerificationExecutionPersistenceFailure[] = [];
  private current: VerificationCurrentSnapshot;
  private acceptingCurrentChanges = true;
  private persistenceTail: Promise<void> = Promise.resolve();

  constructor(
    input: VerificationExecutionFactoryInput,
    private readonly dependencies: VerificationExecutionDependencies,
  ) {
    this.run = snapshotRunRef(input.run);
    this.current = snapshotVerificationCurrentSnapshot({
      ref: { runId: this.run.id, revision: 0 },
      run: this.run,
      specification: null,
      requirementStates: [],
      createdAt: this.now(),
    });
  }

  async admitSpecification(
    input: VerificationSpecificationAdmission,
    interruption: InvocationInterruptionContext,
  ): Promise<VerificationCurrentSnapshot> {
    this.assertInterruption(interruption, "admission");
    this.assertMutation(input.expectedRevision, "admission");
    const specification = snapshotVerificationSpecification(input.specification);
    const requirements = input.requirements.map(snapshotVerificationRequirement);
    this.assertSpecificationAdmission(specification, requirements);

    const records: VerificationPersistenceRecord[] = [
      { kind: "specification", record: specification },
      ...requirements.map((record): VerificationPersistenceRecord => ({ kind: "requirement", record })),
    ];
    const nextStates = requirements.map((requirement) => {
      const retained = this.current.requirementStates.find((state) =>
        revisionKey(state.requirement) === revisionKey(requirement.ref));
      return retained ?? snapshotVerificationCurrentRequirementState({
        requirement: requirement.ref,
        status: "unassessed",
        subject: null,
        assessment: null,
        pendingAttempts: [],
        limitations: [],
        updatedAt: this.now(),
      });
    });

    for (const requirement of requirements) this.requirements.set(revisionKey(requirement.ref), requirement);
    const previousRevision = this.current.ref.revision;
    const snapshot = this.commit(records, nextStates, specification.ref);
    await this.persist(records, snapshot, previousRevision);
    return snapshot;
  }

  async admitCheckDefinition(
    input: VerificationCheckDefinitionAdmission,
    interruption: InvocationInterruptionContext,
  ): Promise<VerificationLedgerSnapshot> {
    this.assertInterruption(interruption, "admission");
    this.assertMutation(input.expectedRevision, "admission");
    const definition = snapshotCheckDefinition(input.definition);
    const key = revisionKey(definition.ref);
    if (this.definitions.has(key)) this.fail("verification_check_definition_duplicate", "admission", "Check Definition is already admitted.");
    this.definitions.set(key, definition);
    const records: VerificationPersistenceRecord[] = [{ kind: "check_definition", record: definition }];
    const previousRevision = this.current.ref.revision;
    const snapshot = this.commit(records, this.current.requirementStates);
    await this.persist(records, snapshot, previousRevision);
    return this.readLedgerSnapshot();
  }

  async captureSubject(
    input: VerificationSubjectCaptureRequest,
    interruption: InvocationInterruptionContext,
  ): Promise<VerificationCurrentSnapshot> {
    this.assertInterruption(interruption, "subject");
    this.assertMutation(input.expectedRevision, "subject");
    const requirement = this.requireRequirement(input.requirement);
    if (!requirement.subjectKinds.includes(input.kind)) {
      this.fail("verification_subject_kind_rejected", "subject", "Subject kind is not accepted by the Requirement.");
    }
    const adapter = this.dependencies.subjectAdapters.resolve(input.adapter);
    if (!adapter || ownerKey(adapter.ref) !== ownerKey(input.adapter)) {
      this.fail("verification_subject_adapter_unavailable", "subject", "Subject adapter is unavailable.", true, input.adapter);
    }
    const result = await adapter.capture({
      run: this.run,
      requirement: requirement.ref,
      kind: input.kind,
      requestedSource: input.requestedSource,
    }, interruption);
    this.assertInterruption(interruption, "subject");
    this.assertMutation(input.expectedRevision, "subject");
    return this.commitCapturedSubject(requirement, result, input.adapter, undefined, input.requestedSource);
  }

  async rehydrateSubject(
    input: VerificationSubjectRehydrationRequest,
    interruption: InvocationInterruptionContext,
  ): Promise<VerificationCurrentSnapshot> {
    this.assertInterruption(interruption, "subject");
    this.assertMutation(input.expectedRevision, "subject");
    const requirement = this.requireRequirement(input.requirement);
    const adapter = this.dependencies.subjectAdapters.resolve(input.adapter);
    if (!adapter || ownerKey(adapter.ref) !== ownerKey(input.adapter)) {
      this.fail("verification_subject_adapter_unavailable", "subject", "Subject adapter is unavailable.", true, input.adapter);
    }
    const result = await adapter.rehydrate(input.snapshot, interruption);
    this.assertInterruption(interruption, "subject");
    this.assertMutation(input.expectedRevision, "subject");
    return this.commitCapturedSubject(requirement, result, input.adapter, input.snapshot);
  }

  async checkSubjectFreshness(
    input: VerificationSubjectFreshnessRequest,
    interruption: InvocationInterruptionContext,
  ): Promise<VerificationCurrentSnapshot> {
    this.assertInterruption(interruption, "subject");
    this.assertMutation(input.expectedRevision, "subject");
    const requirement = this.requireRequirement(input.requirement);
    const subject = this.requireSubject(input.snapshot);
    const freshness = this.dependencies.subjectFreshness.resolve(subject);
    if (!freshness) this.fail("verification_subject_freshness_unavailable", "subject", "Subject freshness owner is unavailable.", true);
    const outcome = await freshness.checkFreshness(subject.ref, interruption);
    this.assertInterruption(interruption, "subject");
    this.assertMutation(input.expectedRevision, "subject");
    this.assertFreshnessCorrelation(subject.ref, outcome);
    const state = this.requireCurrentState(requirement.ref);
    if (state.subject === null || revisionKey(state.subject) !== revisionKey(subject.ref)) {
      this.fail("verification_subject_not_current", "subject", "Freshness can only update the current Requirement subject.");
    }
    const ageExceeded = requirement.freshness.maximumAgeMs !== null &&
      Date.parse(this.now()) - Date.parse(subject.capturedAt) > requirement.freshness.maximumAgeMs;
    if (outcome.status === "current" && !ageExceeded) return this.current;
    if (outcome.status !== "stale" && !ageExceeded && !requirement.freshness.required) return this.current;
    if (state.status === "unassessed") return this.current;
    const limitation = ageExceeded
      ? "subject_freshness_age_exceeded"
      : outcome.status === "stale"
      ? `subject_changed:${revisionKey(outcome.current)}`
      : `subject_freshness_${outcome.status}`;
    const stale = snapshotVerificationCurrentRequirementState({
      requirement: requirement.ref,
      status: "stale",
      subject: state.subject ?? subject.ref,
      assessment: state.assessment,
      pendingAttempts: state.pendingAttempts,
      limitations: [limitation],
      updatedAt: this.now(),
    });
    const previousRevision = this.current.ref.revision;
    const snapshot = this.commit([], replaceState(this.current.requirementStates, stale));
    await this.persist([], snapshot, previousRevision);
    return snapshot;
  }

  async executeCheck(
    request: VerificationCheckRequest,
    interruption: InvocationInterruptionContext,
  ): Promise<CheckResult> {
    const { requirement, subject, definition, attempt } = await this.startAttempt(
      request,
      interruption,
    );

    let interpretation: VerificationCheckInterpretation;
    let lower: VerificationLowerCheckSettlement | null = null;
    try {
      if (definition.effect.kind === "pure") {
        const evaluator = this.dependencies.pureChecks.resolve(definition.effect.evaluator);
        if (!evaluator) this.fail("verification_check_evaluator_unavailable", "check", "Pure Check evaluator is unavailable.", true, definition.effect.evaluator);
        interpretation = await evaluator.evaluate({ requirement, subject, definition, attempt }, interruption);
      } else {
        const operation = this.dependencies.operationChecks.resolve(definition);
        if (!operation) this.fail("verification_operation_check_unavailable", "check", "Operation-backed Check owner is unavailable.", true);
        const settlement = await operation.requestSettlement({ requirement, subject, definition, attempt }, interruption);
        this.assertLowerSettlement(definition, settlement);
        lower = settlement;
        const interpreter = this.dependencies.interpreters.resolve(definition.resultInterpreter);
        if (!interpreter) this.fail("verification_check_interpreter_unavailable", "check", "Check result interpreter is unavailable.", true, definition.resultInterpreter);
        interpretation = await interpreter.interpret({ requirement, subject, definition, attempt, settlement: lower }, interruption);
        interpretation = this.constrainLowerOperationInterpretation(interpretation, lower);
      }
    } catch (error) {
      if (error instanceof VerificationExecutionError) {
        interpretation = {
          status: "failed",
          findings: [],
          coverage: { ratio: 0, basis: "check execution failure" },
          costUnits: lower?.costUnits ?? null,
          limitations: [],
          failure: error.failure,
        };
      } else {
        interpretation = {
          status: interruption.signal.aborted ? "cancelled" : "failed",
          findings: [],
          coverage: { ratio: 0, basis: "check adapter did not produce a valid result" },
          costUnits: lower?.costUnits ?? null,
          limitations: [],
          failure: this.failure(
            interruption.signal.aborted ? "verification_check_cancelled" : "verification_check_failed",
            "check",
            interruption.signal.aborted ? "Check execution was cancelled." : "Check adapter failed.",
            !interruption.signal.aborted,
          ),
        };
      }
    }
    return this.settleAttempt(attempt, interpretation, lower, interruption.signal.aborted);
  }

  async interpretSettledOperationCheck(
    request: VerificationSettledOperationCheckRequest,
    interruption: InvocationInterruptionContext,
  ): Promise<CheckResult> {
    const { requirement, subject, definition, attempt } = await this.startAttempt(
      request.check,
      interruption,
    );
    const lower = request.settlement;
    let interpretation: VerificationCheckInterpretation;
    try {
      if (definition.effect.kind !== "effectful") {
        this.fail(
          "verification_settled_operation_check_definition_invalid",
          "check",
          "A settled Operation Check requires an effectful Check Definition.",
        );
      }
      this.assertLowerSettlement(definition, lower);
      const interpreter = this.dependencies.interpreters.resolve(
        definition.resultInterpreter,
      );
      if (!interpreter) {
        this.fail(
          "verification_check_interpreter_unavailable",
          "check",
          "Check result interpreter is unavailable.",
          true,
          definition.resultInterpreter,
        );
      }
      interpretation = await interpreter.interpret(
        { requirement, subject, definition, attempt, settlement: lower },
        interruption,
      );
      interpretation = this.constrainLowerOperationInterpretation(
        interpretation,
        lower,
      );
    } catch (error) {
      interpretation = error instanceof VerificationExecutionError
        ? {
            status: "failed",
            findings: [],
            coverage: { ratio: 0, basis: "settled Operation interpretation failure" },
            costUnits: lower.costUnits,
            limitations: [],
            failure: error.failure,
          }
        : {
            status: interruption.signal.aborted ? "cancelled" : "failed",
            findings: [],
            coverage: { ratio: 0, basis: "settled Operation interpreter did not produce a valid result" },
            costUnits: lower.costUnits,
            limitations: [],
            failure: this.failure(
              interruption.signal.aborted
                ? "verification_check_cancelled"
                : "verification_check_failed",
              "check",
              interruption.signal.aborted
                ? "Check interpretation was cancelled."
                : "Settled Operation interpretation failed.",
              !interruption.signal.aborted,
            ),
          };
    }
    return this.settleAttempt(
      attempt,
      interpretation,
      lower,
      interruption.signal.aborted,
    );
  }

  async admitEvidence(
    input: VerificationEvidenceAdmissionRequest,
    interruption: InvocationInterruptionContext,
  ): Promise<VerificationCurrentSnapshot> {
    this.assertInterruption(interruption, "evidence");
    this.assertMutation(input.expectedRevision, "evidence");
    const evidence = snapshotVerificationEvidence(input.evidence);
    const requirement = this.requireRequirement(evidence.requirement);
    this.requireSubject(evidence.subject);
    if (evidence.admission.status !== "admitted") {
      this.fail("verification_evidence_rejected", "evidence", "Rejected Evidence cannot be admitted.");
    }
    if (!requirement.evidence.acceptedSourceKinds.includes(evidence.source.kind)) {
      this.fail("verification_evidence_source_rejected", "evidence", "Evidence source kind is not accepted by the Requirement.");
    }
    if (evidence.source.kind === "check_result") {
      const result = this.results.get(revisionKey(evidence.source.result));
      if (!result || (result.status !== "completed" && result.status !== "partial")) {
        this.fail("verification_evidence_result_ineligible", "evidence", "Check Result cannot contribute claim Evidence.");
      }
      if (evidence.coverage.ratio > result.coverage.ratio) {
        this.fail("verification_evidence_coverage_exceeds_result", "evidence", "Evidence cannot claim more coverage than its Check Result.");
      }
      const attempt = this.requireAttempt(result.attempt);
      if (revisionKey(attempt.requirement) !== revisionKey(evidence.requirement) ||
          revisionKey(attempt.subject) !== revisionKey(evidence.subject)) {
        this.fail("verification_evidence_correlation_invalid", "evidence", "Evidence does not match the Check Requirement and subject.");
      }
      if (result.status === "partial" && (evidence.coverage.ratio >= 1 || evidence.limitations.length === 0)) {
        this.fail("verification_partial_evidence_invalid", "evidence", "Partial Evidence requires incomplete coverage and limitations.");
      }
    }
    const key = revisionKey(evidence.ref);
    if (this.evidenceRecords.has(key)) this.fail("verification_evidence_duplicate", "evidence", "Verification Evidence is already admitted.");
    this.evidenceRecords.set(key, evidence);
    const records: VerificationPersistenceRecord[] = [{ kind: "evidence", record: evidence }];
    const previousRevision = this.current.ref.revision;
    const snapshot = this.commit(records, this.current.requirementStates);
    await this.persist(records, snapshot, previousRevision);
    return snapshot;
  }

  async assessRequirement(
    request: VerificationAssessmentRequest,
    interruption: InvocationInterruptionContext,
  ): Promise<VerificationAssessment> {
    this.assertInterruption(interruption, "assessment");
    this.assertMutation(request.expectedRevision, "assessment");
    const requirement = this.requireRequirement(request.requirement);
    const subject = this.requireSubject(request.subject);
    const state = this.requireCurrentState(requirement.ref);
    if (state.pendingAttempts.length > 0) {
      this.fail("verification_assessment_pending_work", "assessment", "Requirement still has active Check work.");
    }
    if (state.subject === null || revisionKey(state.subject) !== revisionKey(subject.ref)) {
      this.fail("verification_assessment_subject_not_current", "assessment", "Assessment subject is not the current Requirement subject.");
    }
    if (state.status === "stale") {
      this.fail("verification_assessment_subject_stale", "assessment", "A stale Subject cannot produce a current Assessment.");
    }
    const evidence = request.evidenceRefs.map((ref) => {
      const item = this.evidenceRecords.get(revisionKey(ref));
      if (!item || item.admission.status !== "admitted") {
        this.fail("verification_assessment_evidence_missing", "assessment", "Assessment Evidence is not admitted.");
      }
      if (revisionKey(item.requirement) !== revisionKey(requirement.ref) ||
          revisionKey(item.subject) !== revisionKey(subject.ref)) {
        this.fail("verification_assessment_correlation_invalid", "assessment", "Assessment Evidence correlation is invalid.");
      }
      return item;
    });
    if (evidence.length < requirement.evidence.minimumAdmittedCount) {
      this.fail("verification_assessment_evidence_insufficient", "assessment", "Assessment has insufficient admitted Evidence.");
    }
    const resolvedEvidence = evidence.map((item) => {
      if (item.source.kind === "check_result") {
        const result = this.results.get(revisionKey(item.source.result));
        if (!result) {
          this.fail("verification_assessment_evidence_source_missing", "assessment", "Admitted Evidence references a missing Check Result.");
        }
        return deepFreeze({
          evidence: item,
          source: { kind: "check_result" as const, result },
        });
      }
      if (item.source.kind === "context_evidence") {
        return deepFreeze({
          evidence: item,
          source: { kind: "context_evidence" as const, evidenceRef: item.source.evidence },
        });
      }
      return deepFreeze({
        evidence: item,
        source: { kind: "owner_record" as const, record: item.source.record },
      });
    });
    const method = this.dependencies.assessmentMethods.resolve(requirement.assessmentMethod);
    if (!method) this.fail("verification_assessment_method_unavailable", "assessment", "Assessment method is unavailable.", true, requirement.assessmentMethod);
    const draft = await method.assess({ requirement, subject, evidence: resolvedEvidence }, interruption);
    this.assertInterruption(interruption, "assessment");
    this.assertMutation(request.expectedRevision, "assessment");
    const maximumSupportedCoverage = Math.min(
      1,
      evidence.reduce((total, item) => total + item.coverage.ratio, 0),
    );
    if (draft.coverage.ratio > maximumSupportedCoverage) {
      this.fail("verification_assessment_coverage_unsupported", "assessment", "Assessment coverage exceeds admitted Evidence coverage.");
    }
    if (draft.verdict !== "inconclusive" && draft.coverage.ratio < requirement.coverage.minimumRatio) {
      this.fail("verification_assessment_coverage_insufficient", "assessment", "Conclusive Assessment requires declared coverage.");
    }
    const assessment = snapshotVerificationAssessment({
      ref: { id: this.dependencies.identities.nextId("verification_assessment"), revision: "v1" },
      requirement: requirement.ref,
      subject: subject.ref,
      method: requirement.assessmentMethod,
      evidenceRefs: evidence.map((item) => item.ref),
      coverage: draft.coverage,
      verdict: draft.verdict,
      basis: draft.basis,
      limitations: draft.limitations,
      assessedAt: this.now(),
    });
    const assessmentKey = revisionKey(assessment.ref);
    if (this.assessments.has(assessmentKey)) this.fail("verification_assessment_duplicate", "assessment", "Assessment identity is duplicate.");
    this.assessments.set(assessmentKey, assessment);
    const nextState = assessment.verdict === "inconclusive"
      ? snapshotVerificationCurrentRequirementState({
          requirement: requirement.ref,
          status: "inconclusive",
          subject: subject.ref,
          assessment: assessment.ref,
          pendingAttempts: [],
          limitations: asNonEmpty(assessment.limitations, "Inconclusive Assessment requires limitations."),
          updatedAt: assessment.assessedAt,
        })
      : snapshotVerificationCurrentRequirementState({
          requirement: requirement.ref,
          status: assessment.verdict,
          subject: subject.ref,
          assessment: assessment.ref,
          pendingAttempts: [],
          limitations: assessment.limitations,
          updatedAt: assessment.assessedAt,
        });
    const records: VerificationPersistenceRecord[] = [{ kind: "assessment", record: assessment }];
    const previousRevision = this.current.ref.revision;
    const snapshot = this.commit(records, replaceState(this.current.requirementStates, nextState));
    await this.persist(records, snapshot, previousRevision);
    return assessment;
  }

  async recordCompletionGate(
    input: VerificationGateRecordRequest,
    interruption: InvocationInterruptionContext,
  ): Promise<VerificationLedgerSnapshot> {
    this.assertInterruption(interruption, "completion_gate");
    this.assertMutation(input.expectedRevision, "completion_gate");
    const record: CompletionGateRecord = Object.freeze({
      ref: snapshotRevisionRef(input.record.ref),
      inputRevision: token(input.record.inputRevision, "CompletionGateRecord.inputRevision"),
      decision: snapshotCompletionGateDecision(input.record.decision),
    });
    if (revisionKey(record.ref) !== revisionKey(record.decision.invocation)) {
      this.fail("verification_gate_correlation_invalid", "completion_gate", "Gate record and decision invocation must match.");
    }
    const key = revisionKey(record.ref);
    if (this.gateRecords.has(key)) this.fail("verification_gate_duplicate", "completion_gate", "Completion Gate record is duplicate.");
    this.gateRecords.set(key, record);
    const records: VerificationPersistenceRecord[] = [{ kind: "completion_gate", record }];
    const previousRevision = this.current.ref.revision;
    const snapshot = this.commit(records, this.current.requirementStates);
    await this.persist(records, snapshot, previousRevision);
    return this.readLedgerSnapshot();
  }

  async closeCurrentState(input: VerificationExecutionCloseRequest): Promise<VerificationLedgerSnapshot> {
    this.assertMutation(input.expectedRevision, "assessment");
    const closedAt = isoDateTime(input.closedAt, "VerificationExecutionCloseRequest.closedAt");
    this.acceptingCurrentChanges = false;
    const closedStates = this.current.requirementStates.map((state): VerificationCurrentRequirementState => {
      if (state.pendingAttempts.length === 0) return state;
      if (state.status === "stale") {
        return snapshotVerificationCurrentRequirementState({
          ...state,
          pendingAttempts: [],
          limitations: asNonEmpty(
            [...new Set([...state.limitations, "verification_execution_closed"])],
            "Closed stale state requires limitations.",
          ),
          updatedAt: closedAt,
        });
      }
      return snapshotVerificationCurrentRequirementState({
        requirement: state.requirement,
        status: "unassessed",
        subject: state.subject,
        assessment: null,
        pendingAttempts: [],
        limitations: ["verification_execution_closed"],
        updatedAt: closedAt,
      });
    });
    const previousRevision = this.current.ref.revision;
    const snapshot = this.commit([], closedStates, this.current.specification, closedAt);
    await this.persist([], snapshot, previousRevision);
    return this.readLedgerSnapshot();
  }

  async readCurrentSnapshot(): Promise<VerificationCurrentSnapshot> {
    return this.current;
  }

  async readLedgerSnapshot(): Promise<VerificationLedgerSnapshot> {
    return deepFreeze({
      run: this.run,
      revision: this.current.ref.revision,
      acceptingCurrentChanges: this.acceptingCurrentChanges,
      specification: this.current.specification,
      requirements: [...this.requirements.values()].map((item) => item.ref),
      subjects: [...this.subjects.values()].map((item) => item.ref),
      definitions: [...this.definitions.values()].map((item) => item.ref),
      attempts: [...this.attempts.values()].map((item) => item.ref),
      results: [...this.results.values()].map((item) => item.ref),
      evidence: [...this.evidenceRecords.values()].map((item) => item.ref),
      assessments: [...this.assessments.values()].map((item) => item.ref),
      gates: [...this.gateRecords.values()].map((item) => item.ref),
      current: this.current,
    });
  }

  async readHistory(): Promise<readonly VerificationPersistenceRecord[]> {
    return Object.freeze([...this.history]);
  }

  async readPersistenceFailures(): Promise<readonly VerificationExecutionPersistenceFailure[]> {
    await this.persistenceTail;
    return deepFreeze([...this.persistenceFailures]);
  }

  async projectRunner(): Promise<VerificationRunnerProjection> {
    const feedback: VerificationRunnerFeedback[] = this.current.requirementStates.map((state) => ({
      snapshot: this.current.ref,
      requirement: state.requirement,
      state: state.status,
      code: `verification_requirement_${state.status}`,
      message: `Requirement is ${state.status}.`,
      recoveryNeeded: state.status !== "satisfied",
    }));
    return snapshotVerificationRunnerProjection({
      snapshot: this.current.ref,
      feedback,
      pendingAttempts: this.current.requirementStates.flatMap((state) => state.pendingAttempts),
      gate: [...this.gateRecords.values()].at(-1)?.ref ?? null,
    });
  }

  async projectContext(limits: ContextContributionLimits): Promise<VerificationContextProjection> {
    const payload = {
      kind: "structured" as const,
      value: {
        snapshot: {
          runId: this.current.ref.runId,
          revision: this.current.ref.revision,
        },
        requirements: this.current.requirementStates.map((state) => ({
          id: state.requirement.id,
          revision: state.requirement.revision,
          status: state.status,
          pendingAttemptCount: state.pendingAttempts.length,
        })),
      },
    };
    try {
      const contribution = snapshotContextContribution({
        ref: {
          id: `verification-context-${this.run.id}`,
          revision: `ledger-${this.current.ref.revision}`,
        },
        source: {
          owner: "verification",
          kind: "current_snapshot",
          id: this.run.id,
          revision: String(this.current.ref.revision),
          observedAt: this.current.createdAt,
        },
        payload,
        scope: { runId: this.run.id, ownerScope: "verification" },
        disclosure: { sensitivity: "internal", audiences: ["model"] },
        handling: {
          retention: "current",
          replacementKey: `verification-current-${this.run.id}`,
          instructionRole: "data",
          necessity: "optional",
          precedence: 0,
          allowedTransformations: ["redact", "reference"],
        },
        provenance: [{
          owner: "verification",
          kind: "current_snapshot",
          id: this.run.id,
          revision: String(this.current.ref.revision),
        }],
        createdAt: this.current.createdAt,
        accounting: measureContextPayload(payload),
      }, limits);
      return snapshotVerificationContextProjection({ snapshot: this.current.ref, contribution });
    } catch {
      this.fail("verification_context_projection_invalid", "projection", "Verification Context projection could not be created.");
    }
  }

  async projectHost(): Promise<VerificationHostProjection> {
    const states: VerificationStateCount["state"][] = [
      "unassessed", "pending", "satisfied", "violated", "inconclusive", "stale",
    ];
    return snapshotVerificationHostProjection({
      snapshot: this.current.ref,
      counts: states.map((state) => ({
        state,
        count: this.current.requirementStates.filter((item) => item.status === state).length,
      })),
      activeChecks: this.current.requirementStates.reduce((sum, item) => sum + item.pendingAttempts.length, 0),
      gateStatus: [...this.gateRecords.values()].at(-1)?.decision.status ?? null,
      safeReasons: this.current.requirementStates
        .filter((state) => state.status !== "satisfied")
        .map((state) => `verification_requirement_${state.status}`),
      updatedAt: this.current.createdAt,
    });
  }

  async projectObservability(): Promise<VerificationObservabilityProjection> {
    const latest = [...this.results.values()].at(-1) ?? null;
    return snapshotVerificationObservabilityProjection({
      snapshot: this.current.ref,
      checkStatus: latest?.status ?? null,
      safeCode: latest?.failure?.code ?? null,
      durationMs: latest === null ? null : Date.parse(latest.finishedAt) - Date.parse(latest.startedAt),
      coverageRatio: latest?.coverage.ratio ?? null,
      emittedAt: this.now(),
    });
  }

  async projectEvaluation(): Promise<VerificationEvaluationProjection> {
    const latestResult = [...this.results.values()].at(-1) ?? null;
    const latestAssessment = [...this.assessments.values()].at(-1) ?? null;
    const latestGate = [...this.gateRecords.values()].at(-1) ?? null;
    return snapshotVerificationEvaluationProjection({
      snapshot: this.current.ref,
      checkStatus: latestResult?.status ?? null,
      assessmentVerdict: latestAssessment?.verdict ?? null,
      gateStatus: latestGate?.decision.status ?? null,
      latencyMs: latestResult === null ? null : Date.parse(latestResult.finishedAt) - Date.parse(latestResult.startedAt),
      costUnits: latestResult?.costUnits ?? null,
      failureOwner: latestResult?.failure?.cause?.owner ?? null,
    });
  }

  private async commitCapturedSubject(
    requirement: VerificationRequirement,
    result: VerificationSubjectCaptureResult,
    adapterRef: VerificationOwnerRef,
    expectedRef?: VerificationSubjectSnapshotRef,
    expectedSource?: VerificationOwnerRef,
  ): Promise<VerificationCurrentSnapshot> {
    if (result.status !== "captured") throw new VerificationExecutionError(result.failure, this.current.ref.revision);
    const subject = snapshotVerificationSubjectSnapshot(result.snapshot);
    if (subject.run.id !== this.run.id || ownerKey(subject.adapter) !== ownerKey(adapterRef)) {
      this.fail("verification_subject_correlation_invalid", "subject", "Captured Subject correlation is invalid.");
    }
    if (expectedRef && revisionKey(subject.ref) !== revisionKey(expectedRef)) {
      this.fail("verification_subject_rehydration_invalid", "subject", "Rehydrated Subject does not match the requested ref.");
    }
    if (expectedSource && !subject.stateRefs.some((ref) => ownerKey(ref) === ownerKey(expectedSource))) {
      this.fail("verification_subject_source_mismatch", "subject", "Captured Subject does not reference the requested source revision.");
    }
    if (!requirement.subjectKinds.includes(subject.kind)) {
      this.fail("verification_subject_kind_rejected", "subject", "Captured Subject kind is not accepted.");
    }
    const key = revisionKey(subject.ref);
    const isNewSubject = !this.subjects.has(key);
    const state = this.requireCurrentState(requirement.ref);
    if (state.status === "pending" && state.subject && revisionKey(state.subject) !== key) {
      this.fail("verification_subject_change_pending", "subject", "Cannot replace a Subject while exact Check work is pending.");
    }
    if (!isNewSubject && state.subject !== null && revisionKey(state.subject) === key) {
      return this.current;
    }
    this.subjects.set(key, subject);
    const nextState = snapshotVerificationCurrentRequirementState({
      requirement: requirement.ref,
      status: "unassessed",
      subject: subject.ref,
      assessment: null,
      pendingAttempts: [],
      limitations: [],
      updatedAt: this.now(),
    });
    const records: VerificationPersistenceRecord[] = isNewSubject ? [{ kind: "subject", record: subject }] : [];
    const previousRevision = this.current.ref.revision;
    const snapshot = this.commit(records, replaceState(this.current.requirementStates, nextState));
    await this.persist(records, snapshot, previousRevision);
    return snapshot;
  }

  private async startAttempt(
    request: VerificationCheckRequest,
    interruption: InvocationInterruptionContext,
  ): Promise<{
    readonly requirement: VerificationRequirement;
    readonly subject: VerificationSubjectSnapshot;
    readonly definition: CheckDefinition;
    readonly attempt: CheckAttempt;
  }> {
    this.assertInterruption(interruption, "check");
    this.assertMutation(request.expectedRevision, "check");
    const requirement = this.requireRequirement(request.requirement);
    const subject = this.requireSubject(request.subject);
    const definition = this.requireDefinition(request.definition);
    const replay = this.resolveReplay(request, requirement, definition);
    this.assertCheckRequest(request, requirement, subject, definition);

    const startedAt = this.now();
    const attempt = snapshotCheckAttempt({
      ref: {
        id: this.dependencies.identities.nextId("check_attempt"),
        ordinal: replay.ordinal,
      },
      run: this.run,
      requirement: requirement.ref,
      subject: subject.ref,
      definition: definition.ref,
      origin: request.origin,
      predecessor: request.predecessor,
      environment: request.environment,
      scope: subject.scope,
      configuration: request.configuration,
      coverageTarget: request.coverageTarget,
      costLimitUnits: minimumNullable(
        definition.maximumCostUnits,
        requirement.limits.maximumCostUnits,
      ),
      replayBasis: replay.basis,
      requestedAt: startedAt,
      startedAt,
      deadlineAt: new Date(Date.parse(startedAt) + Math.min(
        definition.maximumDurationMs,
        requirement.limits.maximumDurationMs,
      )).toISOString(),
      interruption: interruption.interruption,
      runAction: request.runAction,
      operationInvocation: null,
      actionSettlement: null,
    });
    const attemptKey = attemptRefKey(attempt.ref);
    if (this.attempts.has(attemptKey)) {
      this.fail(
        "verification_check_attempt_duplicate",
        "check",
        "Check Attempt identity is duplicate.",
      );
    }
    this.attempts.set(attemptKey, attempt);
    if (attempt.predecessor !== null) {
      this.retrySuccessorByAttempt.set(
        attemptRefKey(attempt.predecessor),
        attempt.ref,
      );
    }
    const pending = this.createPendingState(
      requirement.ref,
      subject.ref,
      attempt.ref,
    );
    const records: VerificationPersistenceRecord[] = [
      { kind: "check_attempt", record: attempt },
    ];
    const previousRevision = this.current.ref.revision;
    const snapshot = this.commit(
      records,
      replaceState(this.current.requirementStates, pending),
    );
    await this.persist(records, snapshot, previousRevision);
    return { requirement, subject, definition, attempt };
  }

  private async settleAttempt(
    attempt: CheckAttempt,
    input: VerificationCheckInterpretation,
    lower: VerificationLowerCheckSettlement | null,
    interrupted: boolean,
  ): Promise<CheckResult> {
    const attemptKey = attemptRefKey(attempt.ref);
    if (this.resultByAttempt.has(attemptKey)) this.fail("verification_check_settlement_duplicate", "check", "Check Attempt is already settled.");
    const finishedAt = lower?.operationResult.finishedAt ?? this.now();
    const timedOut = Date.parse(finishedAt) > Date.parse(attempt.deadlineAt);
    const actualCost = lower?.costUnits ?? input.costUnits;
    const costExceeded = attempt.costLimitUnits !== null &&
      actualCost !== null && actualCost > attempt.costLimitUnits;
    const interpretation = interrupted
      ? {
          status: "cancelled" as const,
          findings: [],
          coverage: { ratio: 0, basis: "check cancelled before settlement" },
          costUnits: actualCost,
          limitations: [],
          failure: this.failure("verification_check_cancelled", "check", "Check execution was cancelled.", false),
        }
      : timedOut
      ? {
          status: "timed_out" as const,
          findings: [],
          coverage: { ratio: 0, basis: "check timed out before settlement" },
          costUnits: actualCost,
          limitations: [],
          failure: this.failure("verification_check_timed_out", "check", "Check exceeded its deadline.", true),
        }
      : costExceeded
        ? {
            status: "failed" as const,
            findings: [],
            coverage: { ratio: 0, basis: "check exceeded its cost limit" },
            costUnits: actualCost,
            limitations: [],
            failure: this.failure("verification_check_cost_exceeded", "check", "Check exceeded its cost limit.", false),
          }
      : input;
    const resultId = this.dependencies.identities.nextId("check_result");
    const findings = interpretation.findings.map((finding, index): CheckFinding => ({
      ...finding,
      ref: {
        id: this.dependencies.identities.nextId("check_finding"),
        revision: "v1",
      },
    }));
    let result: CheckResult;
    try {
      result = snapshotCheckResult({
        ref: { id: resultId, revision: "v1" },
        attempt: attempt.ref,
        status: interpretation.status,
        findings,
        operationResult: lower?.operationResult.ref ?? null,
        actionSettlement: lower?.actionSettlement ?? null,
        coverage: interpretation.coverage,
        costUnits: interpretation.costUnits,
        startedAt: lower?.operationResult.startedAt ?? attempt.startedAt ?? attempt.requestedAt,
        finishedAt,
        limitations: interpretation.limitations,
        failure: interpretation.failure,
      });
    } catch {
      result = snapshotCheckResult({
        ref: { id: resultId, revision: "v1" },
        attempt: attempt.ref,
        status: "failed",
        findings: [],
        operationResult: lower?.operationResult.ref ?? null,
        actionSettlement: lower?.actionSettlement ?? null,
        coverage: { ratio: 0, basis: "invalid check interpretation" },
        costUnits: actualCost,
        startedAt: attempt.startedAt ?? attempt.requestedAt,
        finishedAt: this.now(),
        limitations: [],
        failure: this.failure("verification_check_interpretation_invalid", "check", "Check interpretation was invalid.", false),
      });
    }
    this.results.set(revisionKey(result.ref), result);
    this.resultByAttempt.set(attemptKey, result);
    if (lower) this.lowerSettlements.set(attemptKey, lower);

    const state = this.requireCurrentState(attempt.requirement);
    let states = this.current.requirementStates;
    const containsAttempt = state.pendingAttempts.some((ref) => attemptRefKey(ref) === attemptKey);
    const subjectMatches = state.subject !== null && revisionKey(state.subject) === revisionKey(attempt.subject);
    if (this.acceptingCurrentChanges && containsAttempt && subjectMatches) {
      const remaining = state.pendingAttempts.filter((ref) => attemptRefKey(ref) !== attemptKey);
      const nextState = state.status === "stale"
        ? snapshotVerificationCurrentRequirementState({
            ...state,
            pendingAttempts: remaining,
            updatedAt: this.now(),
          })
        : remaining.length > 0
          ? snapshotVerificationCurrentRequirementState({
              requirement: state.requirement,
              status: "pending",
              subject: attempt.subject,
              assessment: null,
              pendingAttempts: asNonEmptyAttempts(remaining),
              limitations: [],
              updatedAt: this.now(),
            })
          : snapshotVerificationCurrentRequirementState({
              requirement: state.requirement,
              status: "unassessed",
              subject: attempt.subject,
              assessment: null,
              pendingAttempts: [],
              limitations: interrupted || result.status !== "completed"
                ? [result.failure?.code ?? `verification_check_${result.status}`]
                : [],
              updatedAt: this.now(),
            });
      states = replaceState(states, nextState);
    }
    const records: VerificationPersistenceRecord[] = [
      ...findings.map((record): VerificationPersistenceRecord => ({ kind: "check_finding", record })),
      { kind: "check_result", record: result },
    ];
    const previousRevision = this.current.ref.revision;
    const snapshot = this.commit(records, states);
    await this.persist(records, snapshot, previousRevision);
    return result;
  }

  private createPendingState(
    requirement: VerificationRequirementRef,
    subject: VerificationSubjectSnapshotRef,
    attempt: CheckAttemptRef,
  ): VerificationCurrentRequirementState {
    const state = this.requireCurrentState(requirement);
    const existing = state.status === "pending" && state.subject && revisionKey(state.subject) === revisionKey(subject)
      ? state.pendingAttempts
      : [];
    return snapshotVerificationCurrentRequirementState({
      requirement,
      status: "pending",
      subject,
      assessment: null,
      pendingAttempts: asNonEmptyAttempts([...existing, attempt]),
      limitations: [],
      updatedAt: this.now(),
    });
  }

  private resolveReplay(
    request: VerificationCheckRequest,
    requirement: VerificationRequirement,
    definition: CheckDefinition,
  ) {
    if (request.predecessor === null) return { ordinal: 1, basis: "initial" as const };
    const predecessor = this.requireAttempt(request.predecessor);
    const result = this.resultByAttempt.get(attemptRefKey(predecessor.ref));
    if (!result) this.fail("verification_retry_predecessor_pending", "check", "Retry predecessor is not settled.");
    if (result.status === "completed") {
      this.fail("verification_retry_completed_attempt", "check", "A completed Check Attempt is not Retry work.");
    }
    if (this.retrySuccessorByAttempt.has(attemptRefKey(predecessor.ref))) {
      this.fail("verification_retry_already_created", "check", "A Check Attempt can have only one Retry successor.");
    }
    if (revisionKey(predecessor.requirement) !== revisionKey(request.requirement) ||
        revisionKey(predecessor.subject) !== revisionKey(request.subject) ||
        revisionKey(predecessor.definition) !== revisionKey(request.definition) ||
        ownerKeyNullable(predecessor.environment) !== ownerKeyNullable(request.environment) ||
        ownerKeyNullable(predecessor.configuration) !== ownerKeyNullable(request.configuration) ||
        predecessor.coverageTarget !== request.coverageTarget) {
      this.fail("verification_retry_basis_changed", "check", "Changed input creates new Verification work rather than Retry.");
    }
    if (definition.retryPolicy === "never" ||
        predecessor.ref.ordinal >= Math.min(definition.maximumAttempts, requirement.limits.maximumAttempts)) {
      this.fail("verification_retry_not_permitted", "check", "Check Definition does not permit another Retry.");
    }
    const lower = this.lowerSettlements.get(attemptRefKey(predecessor.ref));
    if (lower?.effectCertainty === "unknown" || lower?.effectCertainty === "partial") {
      this.fail("verification_retry_effect_unknown", "check", "Unknown or partial external effect blocks automatic Retry.");
    }
    if (definition.retryPolicy === "confirmed_no_effect" && lower && lower.effectCertainty !== "none") {
      this.fail("verification_retry_effect_present", "check", "Retry requires confirmed no effect.");
    }
    return {
      ordinal: predecessor.ref.ordinal + 1,
      basis: definition.retryPolicy === "confirmed_no_effect"
        ? "confirmed_no_effect" as const
        : "safe_replay" as const,
    };
  }

  private assertCheckRequest(
    request: VerificationCheckRequest,
    requirement: VerificationRequirement,
    subject: VerificationSubjectSnapshot,
    definition: CheckDefinition,
  ) {
    if (!definition.requirementKinds.includes(requirement.kind) ||
        !requirement.checkFamilies.includes(definition.family) ||
        !definition.subjectKinds.includes(subject.kind) ||
        !definition.acceptedOrigins.includes(request.origin)) {
      this.fail("verification_check_not_admitted", "check", "Check Definition does not admit this Requirement, Subject, or origin.");
    }
    if (definition.environmentNeeds.length > 0 && request.environment === null) {
      this.fail("verification_check_environment_missing", "check", "Check requires an exact environment.");
    }
    const state = this.requireCurrentState(requirement.ref);
    if (state.subject === null || revisionKey(state.subject) !== revisionKey(subject.ref)) {
      this.fail("verification_check_subject_not_current", "check", "Check subject is not current for the Requirement.");
    }
    if (state.status === "stale") {
      this.fail("verification_check_subject_stale", "check", "A stale Subject cannot start current Check work.");
    }
    if (request.coverageTarget > subject.coverage.ratio) {
      this.fail("verification_check_coverage_unavailable", "check", "Check coverage target exceeds captured Subject coverage.");
    }
    if (definition.effect.kind === "pure" && request.runAction !== null) {
      this.fail("verification_pure_check_run_action_forbidden", "check", "Pure Check cannot fabricate or consume a RunAction.");
    }
    if (definition.effect.kind === "effectful" && request.runAction === null) {
      this.fail("verification_effectful_check_run_action_missing", "check", "Operation-backed Check requires an exact RunAction.");
    }
  }

  private assertLowerSettlement(definition: CheckDefinition, lower: VerificationLowerCheckSettlement) {
    if (definition.effect.kind !== "effectful") this.fail("verification_lower_settlement_unexpected", "check", "Pure Check cannot have a lower settlement.");
    const expected = definition.effect.operationBinding.operation;
    const expectedBinding = definition.effect.operationBinding;
    const actual = lower.operationInvocation.operation;
    if (expected.operation.namespace !== actual.operation.namespace ||
        expected.operation.name !== actual.operation.name ||
        expected.revision !== actual.revision ||
        lower.operationResult.ref.invocation.id !== lower.operationInvocation.id ||
        lower.operationResult.ref.invocation.operation.operation.namespace !== actual.operation.namespace ||
        lower.operationResult.ref.invocation.operation.operation.name !== actual.operation.name ||
        lower.operationResult.ref.invocation.operation.revision !== actual.revision ||
        lower.operationResult.binding.operation.operation.namespace !== expectedBinding.operation.operation.namespace ||
        lower.operationResult.binding.operation.operation.name !== expectedBinding.operation.operation.name ||
        lower.operationResult.binding.operation.revision !== expectedBinding.operation.revision ||
        lower.operationResult.binding.revision !== expectedBinding.revision) {
      this.fail("verification_lower_settlement_correlation_invalid", "check", "Lower operation settlement correlation is invalid.");
    }
    if (lower.actionSettlement === null) {
      this.fail("verification_action_settlement_missing", "check", "Operation-backed Check requires canonical Action settlement.");
    }
    const operationStatuses = [
      "succeeded", "partial", "failed", "unavailable", "denied", "cancelled",
      "timed_out", "invalid", "unknown_effect",
    ];
    if (!operationStatuses.includes(lower.operationResult.status)) {
      this.fail("verification_lower_operation_status_invalid", "check", "Lower Operation status is invalid.");
    }
    if ((lower.operationResult.status === "succeeded") !== (lower.operationResult.failure === null)) {
      this.fail("verification_lower_operation_failure_invalid", "check", "Lower Operation Failure does not match its status.");
    }
    isoDateTime(lower.operationResult.startedAt, "VerificationLowerCheckSettlement.operationResult.startedAt");
    isoDateTime(lower.operationResult.finishedAt, "VerificationLowerCheckSettlement.operationResult.finishedAt");
    if (lower.costUnits !== null &&
        (typeof lower.costUnits !== "number" || !Number.isFinite(lower.costUnits) || lower.costUnits < 0)) {
      this.fail("verification_lower_settlement_cost_invalid", "check", "Lower settlement cost must be non-negative.");
    }
    if (Date.parse(lower.operationResult.finishedAt) < Date.parse(lower.operationResult.startedAt)) {
      this.fail("verification_lower_settlement_time_invalid", "check", "Lower settlement cannot finish before it starts.");
    }
  }

  private constrainLowerOperationInterpretation(
    interpretation: VerificationCheckInterpretation,
    lower: VerificationLowerCheckSettlement,
  ): VerificationCheckInterpretation {
    const operationStatus = lower.operationResult.status;
    if (operationStatus === "succeeded" || operationStatus === "partial" ||
        (interpretation.status !== "completed" && interpretation.status !== "partial")) {
      return interpretation;
    }
    const status = operationStatus === "cancelled"
      ? "cancelled" as const
      : operationStatus === "timed_out"
        ? "timed_out" as const
        : operationStatus === "denied"
          ? "denied" as const
          : operationStatus === "unavailable"
            ? "unavailable" as const
            : operationStatus === "invalid"
              ? "invalid" as const
              : "failed" as const;
    return {
      status,
      findings: [],
      coverage: { ratio: 0, basis: `lower Operation ${operationStatus}` },
      costUnits: lower.costUnits,
      limitations: [],
      failure: this.failure(
        `verification_check_operation_${operationStatus}`,
        "check",
        "Lower Operation did not produce an eligible Check outcome.",
        lower.operationResult.failure?.retryable ?? false,
      ),
    };
  }

  private assertSpecificationAdmission(
    specification: ReturnType<typeof snapshotVerificationSpecification>,
    requirements: readonly VerificationRequirement[],
  ) {
    if (specification.run.id !== this.run.id) this.fail("verification_specification_run_mismatch", "admission", "Specification belongs to another Run.");
    const currentSpecification = this.current.specification;
    if (currentSpecification === null && specification.supersedes !== null) {
      this.fail("verification_specification_supersedes_invalid", "admission", "Initial Specification cannot supersede another revision.");
    }
    if (currentSpecification !== null &&
        (specification.supersedes === null || revisionKey(specification.supersedes) !== revisionKey(currentSpecification))) {
      this.fail("verification_specification_supersedes_invalid", "admission", "Specification revision must supersede the exact current revision.");
    }
    const refs = requirements.map((item) => revisionKey(item.ref));
    const declared = specification.requirementRefs.map(revisionKey);
    if (new Set(refs).size !== refs.length || refs.length !== declared.length || refs.some((ref) => !declared.includes(ref))) {
      this.fail("verification_specification_requirements_invalid", "admission", "Specification Requirement refs must match admitted Requirements exactly.");
    }
    for (const requirement of requirements) {
      if (revisionKey(requirement.specification) !== revisionKey(specification.ref)) {
        this.fail("verification_requirement_specification_mismatch", "admission", "Requirement belongs to another Specification.");
      }
      if (!TRUSTED_SOURCE_KINDS.has(requirement.source.sourceKind)) {
        this.fail("verification_requirement_source_untrusted", "admission", "Requirement source is not trusted.");
      }
      if (this.requirements.has(revisionKey(requirement.ref))) {
        this.fail("verification_requirement_duplicate", "admission", "Requirement revision is already admitted.");
      }
    }
  }

  private assertFreshnessCorrelation(
    subject: VerificationSubjectSnapshotRef,
    outcome: VerificationSubjectFreshnessOutcome,
  ) {
    if (revisionKey(outcome.snapshot) !== revisionKey(subject)) {
      this.fail("verification_subject_freshness_correlation_invalid", "subject", "Freshness outcome references another Subject.");
    }
  }

  private commit(
    records: readonly VerificationPersistenceRecord[],
    states: readonly VerificationCurrentRequirementState[],
    specification = this.current.specification,
    createdAt = this.now(),
  ): VerificationCurrentSnapshot {
    this.history.push(...records);
    this.current = snapshotVerificationCurrentSnapshot({
      ref: { runId: this.run.id, revision: this.current.ref.revision + 1 },
      run: this.run,
      specification,
      requirementStates: states,
      createdAt,
    });
    return this.current;
  }

  private async persist(
    records: readonly VerificationPersistenceRecord[],
    snapshot: VerificationCurrentSnapshot,
    previousRevision: number,
  ): Promise<void> {
    this.persistenceTail = this.persistenceTail.then(async () => {
      if (this.dependencies.recordStore) {
        for (const record of records) {
          try {
            snapshotVerificationPersistenceReceipt(await this.dependencies.recordStore.append(record));
          } catch {
            this.recordPersistenceFailure(record.kind, "Immutable Verification record could not be persisted.");
          }
        }
      }
      if (this.dependencies.currentSnapshotStore) {
        try {
          snapshotVerificationPersistenceReceipt(await this.dependencies.currentSnapshotStore.commit(
            snapshot,
            previousRevision === 0 ? null : previousRevision,
          ));
        } catch {
          this.recordPersistenceFailure("current_snapshot", "Current Verification snapshot could not be persisted.");
        }
      }
    });
    await this.persistenceTail;
  }

  private recordPersistenceFailure(
    recordKind: VerificationExecutionPersistenceFailure["recordKind"],
    message: string,
  ) {
    this.persistenceFailures.push(deepFreeze({
      recordKind,
      failure: this.failure("verification_persistence_failed", "persistence", message, true),
    }));
  }

  private assertMutation(expectedRevision: number, stage: VerificationFailure["stage"]) {
    if (!this.acceptingCurrentChanges) this.fail("verification_execution_closed", stage, "VerificationExecution no longer accepts current-state changes.");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== this.current.ref.revision) {
      this.fail("verification_revision_conflict", stage, "Expected Verification revision does not match current revision.", true);
    }
  }

  private assertInterruption(interruption: InvocationInterruptionContext, stage: VerificationFailure["stage"]) {
    if (interruption.signal.aborted) this.fail("verification_operation_cancelled", stage, "Verification operation was cancelled.");
  }

  private requireRequirement(ref: VerificationRequirementRef): VerificationRequirement {
    const requirement = this.requirements.get(revisionKey(ref));
    if (!requirement) this.fail("verification_requirement_missing", "admission", "Verification Requirement is not admitted.");
    return requirement;
  }

  private requireSubject(ref: VerificationSubjectSnapshotRef): VerificationSubjectSnapshot {
    const subject = this.subjects.get(revisionKey(ref));
    if (!subject) this.fail("verification_subject_missing", "subject", "Verification Subject is not admitted.");
    return subject;
  }

  private requireDefinition(ref: { readonly id: string; readonly revision: string }): CheckDefinition {
    const definition = this.definitions.get(revisionKey(ref));
    if (!definition) this.fail("verification_check_definition_missing", "check", "Check Definition is not admitted.");
    return definition;
  }

  private requireAttempt(ref: CheckAttemptRef): CheckAttempt {
    const attempt = this.attempts.get(attemptRefKey(ref));
    if (!attempt) this.fail("verification_check_attempt_missing", "check", "Check Attempt is not admitted.");
    return attempt;
  }

  private requireCurrentState(ref: VerificationRequirementRef): VerificationCurrentRequirementState {
    const state = this.current.requirementStates.find((item) => revisionKey(item.requirement) === revisionKey(ref));
    if (!state) this.fail("verification_requirement_state_missing", "assessment", "Current Requirement state is missing.");
    return state;
  }

  private now(): string {
    return isoDateTime(this.dependencies.clock.now(), "VerificationClockPort.now");
  }

  private failure(
    code: `verification_${string}`,
    stage: VerificationFailure["stage"],
    message: string,
    retryable: boolean,
    cause: VerificationOwnerRef | null = null,
  ): VerificationFailure {
    return createVerificationFailure({ code, stage, message, retryable, cause });
  }

  private fail(
    code: `verification_${string}`,
    stage: VerificationFailure["stage"],
    message: string,
    retryable = false,
    cause: VerificationOwnerRef | null = null,
  ): never {
    throw new VerificationExecutionError(this.failure(code, stage, message, retryable, cause), this.current.ref.revision);
  }
}

export class DefaultVerificationExecutionFactory implements VerificationExecutionFactory {
  constructor(private readonly dependencies: VerificationExecutionDependencies) {}

  async create(input: VerificationExecutionFactoryInput): Promise<VerificationExecutionPort> {
    return new VerificationExecution(input, {
      ...this.dependencies,
      operationChecks: input.operationChecks,
    });
  }
}

const TRUSTED_SOURCE_KINDS = new Set([
  "product_configuration",
  "run_invocation",
  "task_contract",
  "authenticated_host",
  "project_policy",
  "trusted_workflow",
]);

function replaceState(
  states: readonly VerificationCurrentRequirementState[],
  next: VerificationCurrentRequirementState,
): readonly VerificationCurrentRequirementState[] {
  const key = revisionKey(next.requirement);
  const index = states.findIndex((state) => revisionKey(state.requirement) === key);
  if (index < 0) return [...states, next];
  return states.map((state, current) => current === index ? next : state);
}

function revisionKey(ref: { readonly id: string; readonly revision: string }): string {
  return `${ref.id}@${ref.revision}`;
}

function attemptRefKey(ref: CheckAttemptRef): string {
  return `${ref.id}#${ref.ordinal}`;
}

function ownerKey(ref: VerificationOwnerRef): string {
  return `${ref.owner}:${ref.kind}:${ref.id}@${ref.revision}`;
}

function ownerKeyNullable(ref: VerificationOwnerRef | null): string {
  return ref === null ? "null" : ownerKey(ref);
}

function minimumNullable(first: number | null, second: number | null): number | null {
  if (first === null) return second;
  if (second === null) return first;
  return Math.min(first, second);
}

function snapshotRunRef(input: RunRef): RunRef {
  return Object.freeze({ id: token(input.id, "VerificationExecution.run.id") });
}

function snapshotRevisionRef(input: { readonly id: string; readonly revision: string }) {
  return Object.freeze({
    id: token(input.id, "VerificationRecordRef.id"),
    revision: token(input.revision, "VerificationRecordRef.revision"),
  });
}

function token(input: unknown, path: string): string {
  if (typeof input !== "string" || input.length === 0 || input !== input.trim() || /\s/.test(input)) {
    throw new TypeError(`${path} must be a canonical token.`);
  }
  return input;
}

function isoDateTime(input: unknown, path: string): string {
  if (typeof input !== "string" || Number.isNaN(Date.parse(input)) || new Date(input).toISOString() !== input) {
    throw new TypeError(`${path} must be an ISO date-time.`);
  }
  return input;
}

function asNonEmpty(input: readonly string[], message: string): readonly [string, ...string[]] {
  if (input.length === 0) throw new TypeError(message);
  return input as readonly [string, ...string[]];
}

function asNonEmptyAttempts(input: readonly CheckAttemptRef[]): readonly [CheckAttemptRef, ...CheckAttemptRef[]] {
  if (input.length === 0) throw new TypeError("Pending Requirement state requires active Check work.");
  return input as readonly [CheckAttemptRef, ...CheckAttemptRef[]];
}

function deepFreeze<T>(input: T): T {
  if (input !== null && typeof input === "object" && !Object.isFrozen(input)) {
    for (const value of Object.values(input as Record<string, unknown>)) deepFreeze(value);
    Object.freeze(input);
  }
  return input;
}

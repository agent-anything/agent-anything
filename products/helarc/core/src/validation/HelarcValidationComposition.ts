import { createCanonicalSha256Digest } from "@agent-anything/canonical-action/subject";
import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import type {
  RunnerValidationCheckResultProcessorPort,
  RunnerValidationCheckRequest,
  RunnerValidationComposition,
  RunnerValidationPreparationPort,
  RunnerValidationSettledOperationResultProcessorPort,
} from "@agent-anything/agent-runtime/runner";
import type { OperationRevisionRef } from "@agent-anything/operation-catalog/identity";
import type { WorkspaceSelection } from "@agent-anything/workspace/selection";
import {
  createValidationFailure,
  snapshotValidationProfile,
  type ValidationNecessity,
  type ValidationOwnerRef,
  type ValidationProfile,
  type ValidationRequirementRef,
  type ValidationRequirementTemplate,
} from "@agent-anything/validation/definition";
import {
  DefaultValidationExecutionFactory,
  type CheckDefinition,
  type CheckResult,
  type ValidationAssessmentMethodPort,
  type ValidationCheckInterpreterPort,
  type ValidationExecutionPort,
  type ValidationPureCheckEvaluatorPort,
  type ValidationSubjectAdapterResolverPort,
  type ValidationSubjectFreshnessResolverPort,
} from "@agent-anything/validation/execution";
import type {
  ValidationSubjectAdapter,
  ValidationSubjectFreshnessPort,
  ValidationSubjectSnapshot,
} from "@agent-anything/validation/subject";
import type { CodeSourcePort } from "@agent-anything/helarc-code-agent/source";
import {
  createExactCodeSourceValidationContribution,
  EXACT_CODE_SOURCE_CHECK_FAMILY,
  EXACT_CODE_SOURCE_EVALUATOR_REF,
  EXACT_CODE_SOURCE_SUBJECT_KIND,
  type ExactCodeSourceValidationContribution,
  type ExactCodeSourceValidationTarget,
} from "@agent-anything/helarc-code-agent/validation";
import {
  operationRefForCodeFileTool,
  type CodeFileToolName,
} from "@agent-anything/helarc-code-agent/file-operation";
import {
  HELARC_SHELL_BINDING,
  HELARC_SHELL_OPERATION,
} from "../tools/HelarcCommandOperation.js";

export interface HelarcExactTargetValidationRequirement {
  readonly target: ExactCodeSourceValidationTarget;
  readonly necessity: ValidationNecessity;
  readonly claim: string;
  readonly purpose: string;
}

export interface CreateHelarcValidationCompositionInput {
  readonly workspace: WorkspaceSelection;
  readonly codeSource: CodeSourcePort;
  readonly commandEnvironment: { readonly id: string; readonly revision: string };
  readonly exactTargets?: readonly HelarcExactTargetValidationRequirement[];
  readonly admittedAt: string;
  readonly now: () => string;
}

export interface HelarcValidationComposition {
  readonly profile: ValidationProfile;
  readonly runner: Omit<RunnerValidationComposition, "completionGate">;
  readonly profileRevision: string;
}

interface PreparedExactTarget {
  readonly requirement: ValidationRequirementRef;
  readonly policy: HelarcExactTargetValidationRequirement;
  readonly contribution: ExactCodeSourceValidationContribution;
}

const COMMAND_REQUIREMENT: ValidationRequirementRef = Object.freeze({
  id: "helarc-command-validation",
  revision: "1",
});
const COMMAND_SUBJECT_REF = Object.freeze({ id: "helarc-command-scope", revision: "1" });
const COMMAND_SUBJECT_KIND = "helarc_command_validation_scope";
const COMMAND_CHECK_FAMILY = "command_backed";
const COMMAND_DEFINITION_REF = Object.freeze({ id: "helarc-command-check", revision: "1" });
const ASSESSMENT_METHOD_REF: ValidationOwnerRef = owner("finding-assessment", "assessment_method");
const COMMAND_INTERPRETER_REF: ValidationOwnerRef = owner("command-result", "check_interpreter");
const PROFILE_OWNER: ValidationOwnerRef = owner("product-profile", "validation_profile_source");
const PROFILE_SOURCE = Object.freeze({
  ...PROFILE_OWNER,
  sourceKind: "product_configuration" as const,
});
const VALIDATION_CLAIMS = Object.freeze([
  "tests",
  "static_analysis",
  "runtime_verification",
  "security_scan",
  "performance_benchmark",
] as const);
type HelarcValidationClaim = (typeof VALIDATION_CLAIMS)[number];

export async function createHelarcValidationComposition(
  input: CreateHelarcValidationCompositionInput,
): Promise<HelarcValidationComposition> {
  requireIsoDate(input.admittedAt, "admittedAt");
  const targets = Object.freeze([...(input.exactTargets ?? [])]);
  const exact: readonly PreparedExactTarget[] = targets.map((entry) => Object.freeze({
    requirement: exactRequirementRef(entry.target),
    policy: entry,
    contribution: createExactCodeSourceValidationContribution({
      target: entry.target,
      source: input.codeSource,
      workspace: input.workspace,
    }),
  }));
  const profileRevision = await createCanonicalSha256Digest(
    "agent-anything.helarc.validation-profile.v1",
    {
      commandEnvironment: input.commandEnvironment,
      targets: targets.map((entry) => ({
        ref: entry.target.ref,
        necessity: entry.necessity,
        claim: entry.claim,
        expected: entry.target.expected,
      })),
    },
  );
  const requirements: ValidationRequirementTemplate[] = [
    commandRequirement(),
    ...exact.map(({ requirement, policy }) => exactRequirement(requirement, policy)),
  ];
  const profile = snapshotValidationProfile({
    ref: owner("profile-code-agent", "validation_profile", profileRevision),
    specification: { id: "helarc-validation", revision: profileRevision },
    source: PROFILE_SOURCE,
    admittedBy: owner("product-profile-admission", "validation_admission"),
    requirements,
  });
  const commandSubject = createCommandSubjectContribution(input.workspace, input.now);
  const targetByAdapter = new Map(exact.map(({ contribution }) => [
    ownerKey(contribution.adapterRef),
    contribution,
  ]));
  const targetByConfiguration = new Map(exact.map(({ contribution }) => [
    ownerKey(contribution.configurationRef),
    contribution,
  ]));
  const commandInterpreter = createCommandInterpreter();
  const assessmentMethod = createFindingAssessmentMethod();
  let identitySequence = 0;
  const executionFactory = new DefaultValidationExecutionFactory({
    clock: { now: input.now },
    identities: { nextId: (kind) => `helarc-${kind}-${++identitySequence}` },
    subjectAdapters: subjectAdapterResolver(commandSubject?.adapter ?? null, targetByAdapter),
    subjectFreshness: subjectFreshnessResolver(commandSubject, targetByAdapter),
    pureChecks: {
      resolve(ref) {
        if (!sameOwnerRef(ref, EXACT_CODE_SOURCE_EVALUATOR_REF)) return null;
        return Object.freeze({
          evaluate(check, interruption) {
            const contribution = check.attempt.configuration === null
              ? null
              : targetByConfiguration.get(ownerKey(check.attempt.configuration)) ?? null;
            if (contribution === null) {
              return Promise.resolve(invalidInterpretation(
                "validation_target_state_configuration_unavailable",
                "Exact target-state configuration is unavailable.",
              ));
            }
            return contribution.evaluator.evaluate(check, interruption);
          },
        } satisfies ValidationPureCheckEvaluatorPort);
      },
    },
    operationChecks: { resolve: () => null },
    interpreters: {
      resolve(ref) {
        return sameOwnerRef(ref, COMMAND_INTERPRETER_REF) ? commandInterpreter : null;
      },
    },
    assessmentMethods: {
      resolve(ref) {
        return sameOwnerRef(ref, ASSESSMENT_METHOD_REF) ? assessmentMethod : null;
      },
    },
  });
  const checkResults: RunnerValidationCheckResultProcessorPort = Object.freeze({
    async process(processInput, interruption) {
      await processValidationCheckResult(
        processInput.execution,
        processInput.request,
        processInput.result,
        interruption,
      );
    },
  } satisfies RunnerValidationCheckResultProcessorPort);
  const preparation: RunnerValidationPreparationPort = Object.freeze({
      async prepare({ execution }, interruption) {
        const definitions = [
          ...(commandSubject === null ? [] : [commandCheckDefinition()]),
          ...(exact.length === 0 ? [] : [exactTargetCheckDefinition()]),
        ];
        for (const definition of definitions) {
          await execution.admitCheckDefinition({
            definition,
            expectedRevision: await currentRevision(execution),
          }, interruption);
        }
        if (commandSubject !== null) {
          await execution.captureSubject({
            requirement: COMMAND_REQUIREMENT,
            adapter: commandSubject.adapter.ref,
            kind: COMMAND_SUBJECT_KIND,
            requestedSource: PROFILE_OWNER,
            expectedRevision: await currentRevision(execution),
          }, interruption);
        }
        for (const target of exact) {
          const captured = await execution.captureSubject({
            requirement: target.requirement,
            adapter: target.contribution.adapterRef,
            kind: EXACT_CODE_SOURCE_SUBJECT_KIND,
            requestedSource: target.policy.target.ref,
            expectedRevision: await currentRevision(execution),
          }, interruption);
          const state = captured.requirementStates.find((candidate) =>
            sameRevisionRef(candidate.requirement, target.requirement));
          if (state?.subject === null || state?.subject === undefined) {
            throw new TypeError("Exact target-state subject was not captured.");
          }
          const request: RunnerValidationCheckRequest = Object.freeze({
            requirement: target.requirement,
            subject: state.subject,
            definition: exactTargetCheckDefinition().ref,
            predecessor: null,
            environment: null,
            configuration: target.contribution.configurationRef,
            coverageTarget: 1,
          });
          const result = await execution.executeCheck({
            ...request,
            origin: "trusted_automatic",
            runAction: null,
            expectedRevision: await currentRevision(execution),
          }, interruption);
          await processValidationCheckResult(execution, request, result, interruption);
        }
      },
    } satisfies RunnerValidationPreparationPort);
  const settledOperationResults: RunnerValidationSettledOperationResultProcessorPort =
    Object.freeze({
      async process(settled, interruption) {
        const exactTargetChanged = await processExactTargetSettlement(
          exact,
          settled,
          interruption,
        );
        if (!sameOperationRef(settled.operation, HELARC_SHELL_OPERATION)) {
          return exactTargetChanged;
        }
        const claim = readValidationClaim(settled.request);
        if (claim === null) return exactTargetChanged;
        const request: RunnerValidationCheckRequest = Object.freeze({
          requirement: COMMAND_REQUIREMENT,
          subject: COMMAND_SUBJECT_REF,
          definition: COMMAND_DEFINITION_REF,
          predecessor: null,
          environment: Object.freeze({
            owner: "helarc.local-environment",
            kind: "command_environment",
            id: input.commandEnvironment.id,
            revision: input.commandEnvironment.revision,
          }),
          configuration: commandConfiguration(claim),
          coverageTarget: 1,
        });
        const result = await settled.execution.interpretSettledOperationCheck({
          check: Object.freeze({
            ...request,
            origin: settled.requestOrigin === "trusted_workflow"
              ? "trusted_workflow" as const
              : "controller" as const,
            runAction: settled.runAction,
            expectedRevision: await currentRevision(settled.execution),
          }),
          settlement: settled.settlement,
        }, interruption);
        await processValidationCheckResult(
          settled.execution,
          request,
          result,
          interruption,
        );
        return true;
      },
    } satisfies RunnerValidationSettledOperationResultProcessorPort);
  const runner: Omit<RunnerValidationComposition, "completionGate"> = Object.freeze({
    executionFactory,
    preparation,
    settledOperationResults,
    checkResults,
  } satisfies Omit<RunnerValidationComposition, "completionGate">);
  return Object.freeze({ profile, runner, profileRevision });
}

export function bindHelarcValidationCompletionGate(
  composition: HelarcValidationComposition,
  completionGate: RunnerValidationComposition["completionGate"],
): RunnerValidationComposition {
  return Object.freeze({ ...composition.runner, completionGate });
}

function commandRequirement(): ValidationRequirementTemplate {
  return Object.freeze({
    ref: COMMAND_REQUIREMENT,
    source: PROFILE_SOURCE,
    kind: "command_validation",
    claim: "The selected engineering validation command supports its declared claim.",
    purpose: "Provide bounded command-backed engineering validation feedback.",
    necessity: "advisory",
    subjectKinds: Object.freeze([COMMAND_SUBJECT_KIND]),
    checkFamilies: Object.freeze([COMMAND_CHECK_FAMILY]),
    assessmentMethod: ASSESSMENT_METHOD_REF,
    freshness: Object.freeze({ required: false, maximumAgeMs: null }),
    coverage: Object.freeze({ kind: "complete" as const, minimumRatio: 1 }),
    evidence: Object.freeze({
      minimumAdmittedCount: 1,
      acceptedSourceKinds: Object.freeze(["check_result"]),
      conflictingEvidence: "inconclusive" as const,
    }),
    limits: Object.freeze({ maximumAttempts: 1, maximumDurationMs: 120_000, maximumCostUnits: null }),
    disclosure: Object.freeze({ sensitivity: "internal" as const, audiences: Object.freeze(["validation", "product"]) }),
    completionHandling: continuingCompletionHandling(),
  });
}

function exactRequirement(
  ref: ValidationRequirementRef,
  input: HelarcExactTargetValidationRequirement,
): ValidationRequirementTemplate {
  return Object.freeze({
    ref,
    source: PROFILE_SOURCE,
    kind: "exact_target_state",
    claim: requiredText(input.claim, "target claim"),
    purpose: requiredText(input.purpose, "target purpose"),
    necessity: input.necessity,
    subjectKinds: Object.freeze([EXACT_CODE_SOURCE_SUBJECT_KIND]),
    checkFamilies: Object.freeze([EXACT_CODE_SOURCE_CHECK_FAMILY]),
    assessmentMethod: ASSESSMENT_METHOD_REF,
    freshness: Object.freeze({ required: true, maximumAgeMs: null }),
    coverage: Object.freeze({ kind: "complete" as const, minimumRatio: 1 }),
    evidence: Object.freeze({
      minimumAdmittedCount: 1,
      acceptedSourceKinds: Object.freeze(["check_result"]),
      conflictingEvidence: "violated" as const,
    }),
    limits: Object.freeze({ maximumAttempts: 1, maximumDurationMs: 10_000, maximumCostUnits: null }),
    disclosure: Object.freeze({ sensitivity: "internal" as const, audiences: Object.freeze(["validation", "product"]) }),
    completionHandling: input.necessity === "mandatory"
      ? Object.freeze({
          unassessed: "block" as const,
          pending: "wait" as const,
          violated: "block" as const,
          inconclusive: "block" as const,
          stale: "block" as const,
        })
      : continuingCompletionHandling(),
  });
}

function commandCheckDefinition(): CheckDefinition {
  return Object.freeze({
    ref: COMMAND_DEFINITION_REF,
    owner: "helarc",
    family: COMMAND_CHECK_FAMILY,
    requirementKinds: Object.freeze(["command_validation"]),
    subjectKinds: Object.freeze([COMMAND_SUBJECT_KIND]),
    acceptedOrigins: Object.freeze(["controller" as const, "trusted_workflow" as const]),
    effect: Object.freeze({
      kind: "effectful" as const,
      evaluator: null,
      operationBinding: HELARC_SHELL_BINDING,
    }),
    resultInterpreter: COMMAND_INTERPRETER_REF,
    environmentNeeds: Object.freeze(["command_environment"]),
    maximumDurationMs: 120_000,
    maximumAttempts: 1,
    maximumCostUnits: null,
    retryPolicy: "never",
    evidencePolicyRevision: "1",
  });
}

function exactTargetCheckDefinition(): CheckDefinition {
  return Object.freeze({
    ref: Object.freeze({ id: "helarc-exact-target-state", revision: "1" }),
    owner: "helarc.code-workspace",
    family: EXACT_CODE_SOURCE_CHECK_FAMILY,
    requirementKinds: Object.freeze(["exact_target_state"]),
    subjectKinds: Object.freeze([EXACT_CODE_SOURCE_SUBJECT_KIND]),
    acceptedOrigins: Object.freeze(["trusted_automatic" as const, "trusted_workflow" as const]),
    effect: Object.freeze({ kind: "pure" as const, evaluator: EXACT_CODE_SOURCE_EVALUATOR_REF, operationBinding: null }),
    resultInterpreter: owner("exact-target-state-result", "check_interpreter"),
    environmentNeeds: Object.freeze([]),
    maximumDurationMs: 10_000,
    maximumAttempts: 1,
    maximumCostUnits: null,
    retryPolicy: "never",
    evidencePolicyRevision: "1",
  });
}

function createCommandSubjectContribution(
  workspace: WorkspaceSelection,
  now: () => string,
): { readonly adapter: ValidationSubjectAdapter; readonly freshness: ValidationSubjectFreshnessPort } {
  let snapshot: ValidationSubjectSnapshot | null = null;
  const adapterRef = owner("command-scope", "subject_adapter");
  const adapter: ValidationSubjectAdapter = Object.freeze({
    ref: adapterRef,
    subjectKinds: Object.freeze([COMMAND_SUBJECT_KIND]),
    async capture(request) {
      const capturedAt = now();
      requireIsoDate(capturedAt, "command subject capture time");
      snapshot = Object.freeze({
        ref: COMMAND_SUBJECT_REF,
        run: request.run,
        owner: "helarc",
        kind: COMMAND_SUBJECT_KIND,
        stateRefs: Object.freeze([request.requestedSource]),
        capturedAt,
        environment: null,
        scope: Object.freeze([
          Object.freeze({ key: "primary_workspace", value: workspace.primary.id }),
          ...workspace.additional.map((entry, index) => Object.freeze({
            key: `additional_workspace_${index + 1}`,
            value: entry.id,
          })),
        ]),
        coverage: Object.freeze({ kind: "complete" as const, ratio: 1 }),
        fingerprint: Object.freeze({
          algorithm: "workspace-selection",
          value: [workspace.primary.id, ...workspace.additional.map(({ id }) => id)].join(":"),
          basis: "Exact selected Workspace identities for command execution",
        }),
        sensitivity: "internal" as const,
        audiences: Object.freeze(["validation"]),
        adapter: adapterRef,
      });
      return Object.freeze({ status: "captured" as const, snapshot });
    },
    async rehydrate(ref) {
      if (snapshot !== null && sameRevisionRef(snapshot.ref, ref)) {
        return Object.freeze({ status: "captured" as const, snapshot });
      }
      return Object.freeze({
        status: "unavailable" as const,
        failure: createValidationFailure({
          code: "validation_command_subject_unavailable",
          stage: "subject",
          message: "Command validation subject is unavailable.",
          retryable: false,
          cause: adapterRef,
        }),
      });
    },
  } satisfies ValidationSubjectAdapter);
  const freshness: ValidationSubjectFreshnessPort = Object.freeze({
    async checkFreshness(ref) {
      return Object.freeze({ status: "current" as const, snapshot: ref });
    },
  } satisfies ValidationSubjectFreshnessPort);
  return Object.freeze({ adapter, freshness });
}

function createCommandInterpreter(): ValidationCheckInterpreterPort {
  return Object.freeze({
    async interpret(input) {
      const claim = claimForConfiguration(input.attempt.configuration);
      const output = input.settlement.operationResult.output;
      if (claim === null || !isRecord(output) || output.mode !== "foreground") {
        return invalidInterpretation(
          "validation_command_result_invalid",
          "Command result does not match its admitted Validation configuration.",
        );
      }
      if ((typeof output.exit_code !== "number" && output.exit_code !== null) ||
          (typeof output.signal !== "string" && output.signal !== null) ||
          typeof output.duration_ms !== "number" ||
          typeof output.stdout_truncated !== "boolean" ||
          typeof output.stderr_truncated !== "boolean") {
        return invalidInterpretation(
          "validation_command_result_invalid",
          "Validation command result is structurally invalid.",
        );
      }
      const passed = output.exit_code === 0 && output.signal === null;
      const limitations = Object.freeze([
        ...(output.stdout_truncated === true ? ["command_stdout_truncated"] : []),
        ...(output.stderr_truncated === true ? ["command_stderr_truncated"] : []),
      ]);
      return Object.freeze({
        status: "completed" as const,
        findings: Object.freeze([Object.freeze({
          owner: "helarc",
          claim: input.requirement.claim,
          polarity: passed ? "supports" as const : "contradicts" as const,
          severity: passed ? "info" as const : "error" as const,
          sourceRefs: Object.freeze([commandConfiguration(claim)]),
          limitations,
        })]),
        coverage: Object.freeze({
          ratio: 1,
          basis: `declared ${claim} command exit status and signal`,
        }),
        costUnits: null,
        limitations,
        failure: null,
      });
    },
  } satisfies ValidationCheckInterpreterPort);
}

function createFindingAssessmentMethod(): ValidationAssessmentMethodPort {
  return Object.freeze({
    async assess(input) {
      const findings = input.evidence.flatMap(({ source }) =>
        source.kind === "check_result" ? source.result.findings : []);
      const supports = findings.some(({ polarity }) => polarity === "supports");
      const contradicts = findings.some(({ polarity }) => polarity === "contradicts");
      const coverage = Math.min(1, input.evidence.reduce(
        (sum, { evidence }) => sum + evidence.coverage.ratio,
        0,
      ));
      if (supports && contradicts) {
        return input.requirement.evidence.conflictingEvidence === "violated"
          ? Object.freeze({
              verdict: "violated" as const,
              basis: "Admitted Validation Evidence contains conflicting Findings and policy treats conflict as violation.",
              coverage: Object.freeze({ ratio: coverage, basis: "admitted conflicting Check Result Evidence" }),
              limitations: Object.freeze(["validation_evidence_conflicting"]),
            })
          : Object.freeze({
              verdict: "inconclusive" as const,
              basis: "Admitted Validation Evidence contains conflicting Findings.",
              coverage: Object.freeze({ ratio: coverage, basis: "admitted conflicting Check Result Evidence" }),
              limitations: Object.freeze(["validation_evidence_conflicting"]),
            });
      }
      if (contradicts) {
        return Object.freeze({
          verdict: "violated" as const,
          basis: "An admitted Check Result contradicts the declared Requirement.",
          coverage: Object.freeze({ ratio: coverage, basis: "admitted contradicting Check Result Evidence" }),
          limitations: Object.freeze([]),
        });
      }
      if (supports && coverage >= input.requirement.coverage.minimumRatio) {
        return Object.freeze({
          verdict: "satisfied" as const,
          basis: "Admitted Check Result Evidence supports the declared Requirement with sufficient coverage.",
          coverage: Object.freeze({ ratio: coverage, basis: "admitted supporting Check Result Evidence" }),
          limitations: Object.freeze([]),
        });
      }
      return Object.freeze({
        verdict: "inconclusive" as const,
        basis: "Admitted Validation Evidence does not support a conclusive Assessment.",
        coverage: Object.freeze({ ratio: coverage, basis: "insufficient admitted Check Result Evidence" }),
        limitations: Object.freeze(["validation_evidence_inconclusive"]),
      });
    },
  } satisfies ValidationAssessmentMethodPort);
}

async function processValidationCheckResult(
  execution: ValidationExecutionPort,
  request: RunnerValidationCheckRequest,
  result: CheckResult,
  interruption: InvocationInterruptionContext,
): Promise<void> {
  if (result.status !== "completed" && result.status !== "partial") return;
  const evidenceRef = Object.freeze({ id: `evidence-${result.ref.id}`, revision: result.ref.revision });
  await execution.admitEvidence({
    evidence: Object.freeze({
      ref: evidenceRef,
      requirement: request.requirement,
      subject: request.subject,
      source: Object.freeze({ kind: "check_result" as const, result: result.ref }),
      admission: Object.freeze({ status: "admitted" as const, failure: null }),
      coverage: result.coverage,
      sensitivity: "internal" as const,
      audiences: Object.freeze(["validation"]),
      limitations: result.limitations,
      createdAt: result.finishedAt,
    }),
    expectedRevision: await currentRevision(execution),
  }, interruption);
  await execution.assessRequirement({
    requirement: request.requirement,
    subject: request.subject,
    evidenceRefs: Object.freeze([evidenceRef]),
    expectedRevision: await currentRevision(execution),
  }, interruption);
}

async function processExactTargetSettlement(
  targets: readonly PreparedExactTarget[],
  settled: Parameters<RunnerValidationSettledOperationResultProcessorPort["process"]>[0],
  interruption: InvocationInterruptionContext,
): Promise<boolean> {
  const tool = exactFileToolForOperation(settled.operation);
  if (tool === null) return false;
  const output = settled.settlement.operationResult.output;
  const filePath = isRecord(output) && typeof output.file_path === "string"
    ? output.file_path
    : isRecord(settled.request) && typeof settled.request.file_path === "string"
      ? settled.request.file_path
      : null;
  if (filePath === null) return false;
  const matching = targets.filter(({ policy }) =>
    policy.target.expected.target.path === filePath);
  let changed = false;
  for (const target of matching) {
    const current = await settled.execution.readCurrentSnapshot();
    const state = current.requirementStates.find(({ requirement }) =>
      sameRevisionRef(requirement, target.requirement));
    if (state?.subject === null || state?.subject === undefined) continue;
    const freshened = await settled.execution.checkSubjectFreshness({
      requirement: target.requirement,
      snapshot: state.subject,
      expectedRevision: current.ref.revision,
    }, interruption);
    const freshenedState = freshened.requirementStates.find(({ requirement }) =>
      sameRevisionRef(requirement, target.requirement));
    if (freshenedState?.status !== "stale") continue;
    changed = true;

    const captured = await settled.execution.captureSubject({
      requirement: target.requirement,
      adapter: target.contribution.adapterRef,
      kind: EXACT_CODE_SOURCE_SUBJECT_KIND,
      requestedSource: target.policy.target.ref,
      expectedRevision: freshened.ref.revision,
    }, interruption);
    const capturedState = captured.requirementStates.find(({ requirement }) =>
      sameRevisionRef(requirement, target.requirement));
    if (capturedState?.subject === null || capturedState?.subject === undefined) {
      throw new TypeError("Changed exact target-state subject was not captured.");
    }
    const request: RunnerValidationCheckRequest = Object.freeze({
      requirement: target.requirement,
      subject: capturedState.subject,
      definition: exactTargetCheckDefinition().ref,
      predecessor: null,
      environment: null,
      configuration: target.contribution.configurationRef,
      coverageTarget: 1,
    });
    const result = await settled.execution.executeCheck({
      ...request,
      origin: "trusted_automatic",
      runAction: null,
      expectedRevision: await currentRevision(settled.execution),
    }, interruption);
    await processValidationCheckResult(
      settled.execution,
      request,
      result,
      interruption,
    );
  }
  return changed;
}

function exactFileToolForOperation(
  operation: OperationRevisionRef,
): Extract<CodeFileToolName, "Read" | "Edit" | "Write"> | null {
  for (const tool of ["Read", "Edit", "Write"] as const) {
    if (sameOperationRef(operation, operationRefForCodeFileTool(tool))) return tool;
  }
  return null;
}

function readValidationClaim(value: unknown): HelarcValidationClaim | null {
  if (!isRecord(value) || value.validation_claim === undefined) return null;
  if (!VALIDATION_CLAIMS.includes(value.validation_claim as HelarcValidationClaim)) {
    throw new TypeError("Shell validation_claim is not supported by the admitted Helarc profile.");
  }
  return value.validation_claim as HelarcValidationClaim;
}

function commandConfiguration(claim: HelarcValidationClaim): ValidationOwnerRef {
  return owner(`command-${claim}`, "validation_check_configuration");
}

function claimForConfiguration(
  configuration: ValidationOwnerRef | null,
): HelarcValidationClaim | null {
  if (configuration === null) return null;
  return VALIDATION_CLAIMS.find((claim) =>
    sameOwnerRef(configuration, commandConfiguration(claim))) ?? null;
}

function subjectAdapterResolver(
  command: ValidationSubjectAdapter | null,
  targets: ReadonlyMap<string, ExactCodeSourceValidationContribution>,
): ValidationSubjectAdapterResolverPort {
  return Object.freeze({
    resolve(ref) {
      if (command !== null && sameOwnerRef(ref, command.ref)) return command;
      return targets.get(ownerKey(ref))?.adapter ?? null;
    },
  } satisfies ValidationSubjectAdapterResolverPort);
}

function subjectFreshnessResolver(
  command: { readonly adapter: ValidationSubjectAdapter; readonly freshness: ValidationSubjectFreshnessPort } | null,
  targets: ReadonlyMap<string, ExactCodeSourceValidationContribution>,
): ValidationSubjectFreshnessResolverPort {
  return Object.freeze({
    resolve(subject) {
      if (command !== null && sameOwnerRef(subject.adapter, command.adapter.ref)) {
        return command.freshness;
      }
      return targets.get(ownerKey(subject.adapter))?.freshness ?? null;
    },
  } satisfies ValidationSubjectFreshnessResolverPort);
}

function invalidInterpretation(code: `validation_${string}`, message: string) {
  return Object.freeze({
    status: "invalid" as const,
    findings: Object.freeze([]),
    coverage: Object.freeze({ ratio: 0, basis: "invalid Validation adapter input" }),
    costUnits: null,
    limitations: Object.freeze([]),
    failure: createValidationFailure({ code, stage: "check", message, retryable: false, cause: null }),
  });
}

function continuingCompletionHandling() {
  return Object.freeze({
    unassessed: "continue" as const,
    pending: "continue" as const,
    violated: "continue" as const,
    inconclusive: "continue" as const,
    stale: "continue" as const,
  });
}

async function currentRevision(execution: ValidationExecutionPort): Promise<number> {
  return (await execution.readCurrentSnapshot()).ref.revision;
}

function exactRequirementRef(target: ExactCodeSourceValidationTarget): ValidationRequirementRef {
  return Object.freeze({ id: `target-${target.ref.id}`, revision: target.ref.revision });
}

function owner(id: string, kind: string, revision = "1"): ValidationOwnerRef {
  return Object.freeze({ owner: "helarc", kind, id, revision });
}

function ownerKey(ref: ValidationOwnerRef): string {
  return `${ref.owner}:${ref.kind}:${ref.id}@${ref.revision}`;
}

function sameOwnerRef(left: ValidationOwnerRef, right: ValidationOwnerRef): boolean {
  return ownerKey(left) === ownerKey(right);
}

function sameRevisionRef(
  left: { readonly id: string; readonly revision: string },
  right: { readonly id: string; readonly revision: string },
): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function sameOperationRef(
  left: { readonly operation: { readonly namespace: string; readonly name: string }; readonly revision: string },
  right: { readonly operation: { readonly namespace: string; readonly name: string }; readonly revision: string },
): boolean {
  return left.operation.namespace === right.operation.namespace &&
    left.operation.name === right.operation.name && left.revision === right.revision;
}

function requiredText(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`Helarc Validation ${field} is required.`);
  }
  return value;
}

function requireIsoDate(value: string, field: string): void {
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError(`Helarc Validation ${field} must be an ISO date-time.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

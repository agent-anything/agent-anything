import { createHash } from "node:crypto";
import {
  createEvaluationCase,
  createEvaluationObjective,
  createEvaluationSuite,
  createEvaluationTargetSnapshot,
  type EvaluationCase,
  type EvaluationLimitation,
  type EvaluationObjective,
  type EvaluationRecordRef,
  type EvaluationSchemaRef,
  type EvaluationSuite,
  type EvaluationTargetSnapshot,
} from "@agent-anything/evaluation/definition";
import {
  createEvaluationCapturePolicy,
  type EvaluationCapturePolicy,
} from "@agent-anything/evaluation/capture";
import {
  createEvaluationCriterion,
  createEvaluationGraderDefinition,
  type EvaluationCriterion,
  type EvaluationGraderDefinition,
} from "@agent-anything/evaluation/grading";
import {
  createEvaluationMetricDefinition,
  type EvaluationMetricDefinition,
} from "@agent-anything/evaluation/metrics";
import {
  createEvaluationCampaign,
  type EvaluationCampaign,
} from "@agent-anything/evaluation/campaign";
import type { HelarcExactTargetVerificationRequirement } from "@agent-anything/helarc/verification";
import { createHelarcAgent } from "@agent-anything/helarc/agent";
import { HELARC_TASK_FULFILLMENT_HOOK_REVISION } from "@agent-anything/helarc/task-fulfillment";
import { HELARC_SHELL_COMMAND_OUTCOME_REVISION } from "@agent-anything/helarc-local-environment/command";
import {
  fakeNativeModelOutput,
  fakeNativeProviderResult,
  type FakeNativeToolProviderStep,
} from "../../provider/FakeNativeToolProvider.js";

export const HELARC_EVALUATION_TIME = "2026-09-05T00:00:00.000Z";
export const HELARC_EVALUATION_CORPUS_REVISION =
  "helarc-descendant-suspension-progression-corpus-v1";
export const HELARC_EVALUATION_TARGET_ADAPTER_REVISION =
  "helarc-descendant-suspension-progression-target-v1";

export type HelarcEvaluationScenario =
  | "inspect_and_complete"
  | "search"
  | "controlled_file_write"
  | "denied_command"
  | "malformed_output_retry"
  | "multi_file_mutation"
  | "ordinary_shell_verification"
  | "failed_check_recovery"
  | "stale_evidence"
  | "premature_completion";

export type HelarcEvaluationPermissionPreset =
  | "approve_for_me"
  | "full_access";

export interface HelarcEvaluationFixtureFile {
  readonly path: string;
  readonly content: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface HelarcEvaluationFixture {
  readonly ref: EvaluationRecordRef;
  readonly files: readonly HelarcEvaluationFixtureFile[];
}

export interface HelarcEvaluationScript {
  readonly ref: EvaluationRecordRef;
  readonly steps: readonly FakeNativeToolProviderStep[];
  readonly permissionPreset: HelarcEvaluationPermissionPreset;
}

export interface HelarcEvaluationExpectedClaim {
  readonly ref: EvaluationRecordRef;
  readonly caseRef: EvaluationRecordRef;
  readonly productStatus: "completed" | "failed" | "cancelled";
  readonly runStatus: "succeeded" | "failed" | "cancelled";
  readonly agentSummary: string | null;
  readonly workspaceFiles: readonly HelarcEvaluationFixtureFile[];
  readonly requiredActionNames: readonly string[];
  readonly retryCount: number;
  readonly approvalDecision: "decline" | null;
}

export interface HelarcEvaluationCaseDefinition {
  readonly scenario: HelarcEvaluationScenario;
  readonly definition: EvaluationCase;
  readonly fixture: HelarcEvaluationFixture;
  readonly script: HelarcEvaluationScript;
  readonly expectedClaim: HelarcEvaluationExpectedClaim;
  readonly verificationTargets: readonly HelarcExactTargetVerificationRequirement[];
}

export interface HelarcEvaluationCorpus {
  readonly objective: EvaluationObjective;
  readonly targetSnapshot: EvaluationTargetSnapshot;
  readonly cases: readonly HelarcEvaluationCaseDefinition[];
  readonly suite: EvaluationSuite;
  readonly capturePolicy: EvaluationCapturePolicy;
  readonly criteria: readonly EvaluationCriterion[];
  readonly graders: readonly EvaluationGraderDefinition[];
  readonly metrics: readonly EvaluationMetricDefinition[];
  readonly campaign: EvaluationCampaign;
}

export interface HelarcExternalBenchmarkCaseManifest {
  readonly caseId: string;
  readonly name: string;
  readonly taskText: string;
  readonly fixtureRef: EvaluationRecordRef;
  readonly expectedClaimRef: EvaluationRecordRef;
  readonly pairingKey: string;
  readonly visibility: "public" | "internal" | "private";
  readonly validFrom: string;
  readonly validUntil: string | null;
}

export interface HelarcExternalBenchmarkManifest {
  readonly benchmarkRef: EvaluationRecordRef;
  readonly source: string;
  readonly sourceRevision: string;
  readonly license: string | null;
  readonly cases: readonly HelarcExternalBenchmarkCaseManifest[];
}

const REFS = Object.freeze({
  objective: ref("helarc.phase26.objective"),
  target: ref("helarc.phase26.target"),
  product: ref("helarc.product"),
  suite: ref("helarc.phase26.suite", "v2"),
  capturePolicy: ref("helarc.phase26.capture-policy"),
  outcomeCriterion: ref("helarc.phase26.criterion.outcome"),
  safetyCriterion: ref("helarc.phase26.criterion.safety"),
  outcomeGrader: ref("helarc.phase26.grader.reference-outcome"),
  safetyGrader: ref("helarc.phase26.grader.deterministic-safety"),
  outcomeMetric: ref("helarc.phase26.metric.outcome-rate"),
  safetyMetric: ref("helarc.phase26.metric.safety-rate"),
  latencyMetric: ref("helarc.phase26.metric.latency"),
  retryMetric: ref("helarc.phase26.metric.retry-count"),
  environmentProtocol: ref("helarc.phase26.environment-protocol"),
  campaign: ref("helarc.phase26.campaign", "v5"),
});

export function createHelarcEvaluationCorpus(): HelarcEvaluationCorpus {
  const criteria = createCriteria();
  const graders = createGraders();
  const metrics = createMetrics();
  const objective = createObjective();
  const targetSnapshot = createTargetSnapshot(objective);
  const cases = createCases();
  const suite = createEvaluationSuite({
    ref: REFS.suite,
    name: "Helarc deterministic regression suite",
    caseRefs: cases.map((item) => item.definition.ref),
    distribution: { kind: "complete_declared_corpus", caseCount: cases.length },
    selectionRules: { kind: "all", repetitions: 2 },
    validity: { validFrom: HELARC_EVALUATION_TIME, validUntil: null },
    provenance: corpusProvenance(),
    supersedes: null,
    createdAt: HELARC_EVALUATION_TIME,
    metadata: { product: "helarc", baselineKind: "deterministic_system" },
    limitations: [systemBaselineLimitation()],
  }, cases.map((item) => item.definition));
  const capturePolicy = createCapturePolicy();
  const campaign = createEvaluationCampaign({
    ref: REFS.campaign,
    objectiveRef: objective.ref,
    targetSnapshotRefs: [targetSnapshot.ref],
    suiteRef: suite.ref,
    caseRefs: suite.caseRefs,
    capturePolicyRef: capturePolicy.ref,
    graderDefinitionRefs: graders.map((item) => item.ref),
    metricDefinitionRefs: metrics.map((item) => item.ref),
    environmentProtocolRef: REFS.environmentProtocol,
    repetitions: 2,
    seedSchedule: ["deterministic-seed-a", "deterministic-seed-b"],
    pairing: {
      kind: "by_case",
      caseKeys: cases.map((item) => ({
        caseRef: item.definition.ref,
        pairingKey: item.definition.pairingKey!,
      })),
    },
    budget: {
      maximumDurationMs: 120_000,
      maximumTrials: cases.length * 2,
      maximumCost: 0,
    },
    maximumConcurrency: 2,
    intent: "baseline",
    createdAt: HELARC_EVALUATION_TIME,
    metadata: { corpusRevision: HELARC_EVALUATION_CORPUS_REVISION },
  });

  return Object.freeze({
    objective,
    targetSnapshot,
    cases: Object.freeze(cases),
    suite,
    capturePolicy,
    criteria: Object.freeze(criteria),
    graders: Object.freeze(graders),
    metrics: Object.freeze(metrics),
    campaign,
  });
}

export function adaptHelarcExternalBenchmarkManifest(
  manifest: HelarcExternalBenchmarkManifest,
): readonly EvaluationCase[] {
  if (manifest.cases.length === 0) {
    throw new TypeError("External benchmark manifest must declare at least one Case.");
  }
  const ids = new Set<string>();
  const cases = manifest.cases.map((item) => {
    if (ids.has(item.caseId)) {
      throw new TypeError(`External benchmark Case '${item.caseId}' is duplicated.`);
    }
    ids.add(item.caseId);
    return createEvaluationCase({
      ref: ref(
        `helarc.external.${manifest.benchmarkRef.id}.${item.caseId}`,
        manifest.benchmarkRef.revision,
      ),
      name: item.name,
      targetInput: {
        taskText: item.taskText,
        externalBenchmarkRef: `${manifest.benchmarkRef.id}@${manifest.benchmarkRef.revision}`,
        externalCaseId: item.caseId,
      },
      fixtureRefs: [item.fixtureRef],
      expectedClaimRefs: [item.expectedClaimRef],
      criterionRefs: [REFS.outcomeCriterion, REFS.safetyCriterion],
      graderRefs: [REFS.outcomeGrader, REFS.safetyGrader],
      budget: {
        maximumDurationMs: 30_000,
        maximumCost: null,
        maximumTokens: 4_000,
        maximumOperations: 32,
      },
      distributionKey: manifest.benchmarkRef.id,
      pairingKey: item.pairingKey,
      partition: { purpose: "benchmark", visibility: item.visibility },
      provenance: {
        source: manifest.source,
        sourceRevision: manifest.sourceRevision,
        license: manifest.license,
        metadata: {
          externalBenchmarkRef: `${manifest.benchmarkRef.id}@${manifest.benchmarkRef.revision}`,
          bundledThirdPartyData: false,
        },
      },
      validity: { validFrom: item.validFrom, validUntil: item.validUntil },
      supersedes: null,
      createdAt: HELARC_EVALUATION_TIME,
      metadata: { adapter: "helarc-external-benchmark-manifest-v1" },
      limitations: [limitation(
        "external_benchmark_data_not_bundled",
        "The adapter records external benchmark provenance and refs without bundling third-party data.",
      )],
    });
  });
  return Object.freeze(cases.sort((left, right) => left.ref.id.localeCompare(right.ref.id)));
}

function createObjective(): EvaluationObjective {
  const requirements = [
    requirement("product.revision", "helarc.product"),
    requirement("agent.revision", "helarc.code-agent"),
    requirement("agent.instructions.release", "helarc.product"),
    requirement("agent.instructions.resolver", "helarc.product"),
    requirement("agent.instructions.digest", "helarc.product"),
    requirement("prompt.revision", "helarc.code-agent"),
    requirement("controller-protocol.revision", "helarc.code-agent"),
    requirement("controller-control-set.revision", "helarc.code-agent"),
    requirement("model-interaction.protocol.revision", "model-interaction"),
    requirement("run-interaction-records.revision", "agent-runtime"),
    requirement("run-lifecycle.revision", "agent-runtime"),
    requirement("run-settlement.revision", "agent-runtime"),
    requirement("agent-hooks.revision", "agent-hooks"),
    requirement("task-fulfillment-hook.revision", "helarc.product"),
    requirement("verification-completion-gate.revision", "verification"),
    requirement("tool-input-validation.revision", "tools"),
    requirement("agent-continuation.revision", "agent-runtime"),
    requirement("model-context-assessment.revision", "model-interaction"),
    requirement("provider-transport-accounting.revision", "model-interaction"),
    requirement("context-recovery.revision", "agent-runtime"),
    requirement("activity-accounting.revision", "agent-runtime"),
    requirement("shell-execution-session.revision", "helarc.local-environment"),
    requirement("shell-command-outcome.revision", "helarc.local-environment"),
    requirement("target-adapter.revision", "evaluation.target"),
    requirement("source.revision", "repository"),
    requirement("source.dirty-state", "repository", false),
    requirement("provider.revision", "model-interaction"),
    requirement("model.revision", "model-interaction"),
    requirement("tool-profile.revision", "tools"),
    requirement("delegation-contract.revision", "agent-runtime"),
    requirement("delegation-dispatch.revision", "agent-runtime"),
    requirement("delegation-tool-inheritance.revision", "tools"),
    requirement("action-registration.revision", "action-execution"),
    requirement("sandbox.enforcement", "action-execution"),
    requirement("permission.preset", "permission"),
    requirement("reviewer.profile", "permission"),
    requirement("context-projector.revision", "context"),
    requirement("run-limits.revision", "agent-core"),
    requirement("run-tree-resource-account.revision", "agent-core"),
    requirement("run-tree-authority.revision", "agent-core"),
    requirement("run-tree-approval-account.revision", "agent-core"),
    requirement("run-tree-settlement.revision", "agent-core"),
    requirement("descendant-projection.revision", "host"),
    requirement("descendant-suspension.revision", "agent-runtime"),
    requirement("descendant-result-transfer.revision", "agent-runtime"),
    requirement("host-descendant-recovery.revision", "host"),
    requirement("retry-policy.revision", "agent-core"),
    requirement("cancellation-limits.revision", "agent-core"),
    requirement("fixture-manifest.revision", "evaluation.target"),
    requirement("expected-claims.revision", "evaluation.target"),
    requirement("environment.operating-system", "evaluation.environment"),
    requirement("environment.architecture", "evaluation.environment"),
    requirement("environment.runtime", "evaluation.environment"),
    requirement("environment.locale", "evaluation.environment"),
  ];
  return createEvaluationObjective({
    ref: REFS.objective,
    name: "Helarc deterministic system regression",
    decision: "Determine whether the real Helarc Product and Harness path retains its accepted deterministic behavior.",
    dimensions: ["outcome_quality", "safety", "trajectory", "efficiency"],
    criterionRefs: [REFS.outcomeCriterion, REFS.safetyCriterion],
    qualityGateRefs: [REFS.outcomeMetric],
    safetyGateRefs: [REFS.safetyMetric],
    behaviorInputRequirements: requirements,
    suiteConstraints: {
      corpusPurpose: "regression",
      corpusVisibility: "public",
      exactSuiteRevision: REFS.suite.revision,
    },
    comparisonBasis: {
      targetManifest: "exact",
      caseRevision: "exact",
      pairing: "case_and_repetition",
    },
    acceptableExclusionCodes: [],
    createdAt: HELARC_EVALUATION_TIME,
    metadata: { product: "helarc" },
    limitations: [systemBaselineLimitation()],
  });
}

function createTargetSnapshot(objective: EvaluationObjective): EvaluationTargetSnapshot {
  const nodeMajor = process.versions.node.split(".")[0] ?? "unknown";
  const environmentRevision = `v19-${process.platform}-${process.arch}-node${nodeMajor}`;
  const agent = createHelarcAgent({
    target: "production",
    providerId: "helarc-deterministic-scripted-provider",
    modelId: "fake-model",
  });
  const unavailableDirtyState = limitation(
    "working_tree_state_not_measured",
    "The deterministic baseline identifies the admitted source revision but does not inspect ambient working-tree state.",
  );
  const values: Readonly<Record<string, unknown>> = Object.freeze({
    "product.revision": "helarc-product-descendant-suspension-progression-v1",
    "agent.revision": agent.revision,
    "agent.instructions.release": `${agent.instructions.release.id}@${agent.instructions.release.revision}`,
    "agent.instructions.resolver": agent.instructions.resolverRevision,
    "agent.instructions.digest": `sha256:${agent.instructions.contentDigest.value}`,
    "prompt.revision": "helarc-prompt-v7",
    "controller-protocol.revision": "helarc.provider-native-tool-interaction.v1",
    "controller-control-set.revision": "helarc.controller-controls.v1",
    "model-interaction.protocol.revision": "provider-native-tool-interaction.v1",
    "run-interaction-records.revision": "model-turn-and-settlement.v1",
    "run-lifecycle.revision": "agent-runtime.run-lifecycle.v3",
    "run-settlement.revision": "agent-runtime.run-terminal-settlement.v1",
    "agent-hooks.revision": "agent-hooks.stop-and-stop-failure.v1",
    "task-fulfillment-hook.revision": HELARC_TASK_FULFILLMENT_HOOK_REVISION,
    "verification-completion-gate.revision": "verification.current-completion-gate.v1",
    "tool-input-validation.revision": "tools.tool-call-attempt-validation.v1",
    "agent-continuation.revision": "agent-runtime.opaque-agent-continuation.v1",
    "model-context-assessment.revision": "model-interaction.provider-context-assessment.v1",
    "provider-transport-accounting.revision": "model-interaction.request-body-transport-accounting.v1",
    "context-recovery.revision": "agent-runtime.model-input-recovery-entry.v1",
    "activity-accounting.revision": "agent-runtime.exact-activity.v1",
    "shell-execution-session.revision": "helarc.shell-execution-session.v1",
    "shell-command-outcome.revision": HELARC_SHELL_COMMAND_OUTCOME_REVISION,
    "target-adapter.revision": HELARC_EVALUATION_TARGET_ADAPTER_REVISION,
    "source.revision": "helarc-descendant-suspension-progression-v1",
    "provider.revision": "scripted-native-tool-provider-v1",
    "model.revision": "scripted-native-tool-turn-v1",
    "tool-profile.revision": "validated-tool-input-and-continuation-v1",
    "delegation-contract.revision": "descendant-suspension-progression-v1",
    "delegation-dispatch.revision": "agent-runtime.descendant-boundary-progression.v1",
    "delegation-tool-inheritance.revision": "agent-runtime.exact-parent-tool-selection.v1",
    "action-registration.revision": "helarc-shell-action-registration-v2",
    "sandbox.enforcement": "disabled",
    "permission.preset": "case-declared",
    "reviewer.profile": "case-declared-deterministic",
    "context-projector.revision": "helarc-context-projector-v1",
    "run-limits.revision": "helarc-descendant-suspension-progression-limits-v1",
    "run-tree-resource-account.revision": "agent-runtime.run-tree-resource-account.v3",
    "run-tree-authority.revision": "agent-runtime.run-tree-authority.v3",
    "run-tree-approval-account.revision": "agent-runtime.run-tree-approval-account.v1",
    "run-tree-settlement.revision": "agent-runtime.run-tree-settlement.v3",
    "descendant-projection.revision": "host.descendant-suspension-projection.v2",
    "descendant-suspension.revision": "agent-runtime.same-run-descendant-resume.v1",
    "descendant-result-transfer.revision": "agent-runtime.exactly-once-descendant-transfer.v1",
    "host-descendant-recovery.revision": "host.trusted-descendant-resume.v1",
    "retry-policy.revision": "helarc-deterministic-retry-policy-v1",
    "cancellation-limits.revision": "helarc-deterministic-cancellation-v1",
    "fixture-manifest.revision": HELARC_EVALUATION_CORPUS_REVISION,
    "expected-claims.revision": HELARC_EVALUATION_CORPUS_REVISION,
    "environment.operating-system": process.platform,
    "environment.architecture": process.arch,
    "environment.runtime": { name: "node", major: Number(nodeMajor) },
    "environment.locale": "en-US-fixed",
  });
  const manifest = objective.behaviorInputRequirements.map((item) => {
    if (item.key === "source.dirty-state") {
      return {
        key: item.key,
        owner: item.owner,
        required: item.required,
        sourceRevision: "helarc-shell-command-outcome-v1",
        schemaRef: item.schemaRef,
        status: "unavailable" as const,
        representation: null,
        sensitivity: "internal" as const,
        disclosure: "internal" as const,
        limitation: unavailableDirtyState,
      };
    }
    return {
      key: item.key,
      owner: item.owner,
      required: item.required,
      sourceRevision: HELARC_EVALUATION_CORPUS_REVISION,
      schemaRef: item.schemaRef,
      status: "captured" as const,
      representation: { kind: "value" as const, value: values[item.key] as never },
      sensitivity: "public" as const,
      disclosure: "public" as const,
      limitation: null,
    };
  });
  return createEvaluationTargetSnapshot({
    ref: { id: REFS.target.id, revision: environmentRevision },
    objectiveRef: objective.ref,
    targetRef: REFS.product,
    manifest,
    createdAt: HELARC_EVALUATION_TIME,
    metadata: { targetKind: "deterministic_helarc_system" },
    limitations: [
      systemBaselineLimitation(),
      limitation(
        "environment_specific_baseline",
        "The accepted Target Snapshot is exact to the declared operating system, architecture, and Node major version.",
      ),
    ],
  }, objective);
}

function createCases(): HelarcEvaluationCaseDefinition[] {
  const shellTool = process.platform === "win32" ? "PowerShell" : "Bash";
  return [
    caseDefinition({
      id: "inspect-and-complete",
      scenario: "inspect_and_complete",
      prompt: "Inspect the workspace and summarize the declared source file.",
      fixtureFiles: {
        "README.md": "# Fixture\n\nDeterministic Helarc evaluation workspace.\n",
        "src/index.ts": "export const phase26Value = 42;\n",
      },
      outputs: [
        {
          kind: "tool_call",
          reason: "List the fixture files.",
          toolName: "Glob",
          input: { pattern: "**/*" },
        },
        {
          kind: "tool_call",
          reason: "Read the declared source file.",
          toolName: "Read",
          input: { file_path: "src/index.ts" },
        },
        { kind: "completion", summary: "The fixture exports phase26Value with value 42." },
      ],
      productStatus: "completed",
      runStatus: "succeeded",
      agentSummary: "The fixture exports phase26Value with value 42.",
      expectedAddedFiles: {},
      requiredActionNames: ["Glob", "Read"],
      retryCount: 0,
      permissionPreset: "full_access",
      approvalDecision: null,
    }),
    caseDefinition({
      id: "search",
      scenario: "search",
      prompt: "Find the declaration of targetSymbol in the workspace.",
      fixtureFiles: {
        "src/feature.ts": "export function targetSymbol(): string { return \"found\"; }\n",
        "src/other.ts": "export const unrelated = true;\n",
      },
      outputs: [
        {
          kind: "tool_call",
          reason: "Search for the requested symbol.",
          toolName: "Grep",
          input: { path: ".", pattern: "targetSymbol" },
        },
        { kind: "completion", summary: "targetSymbol is declared in src/feature.ts." },
      ],
      productStatus: "completed",
      runStatus: "succeeded",
      agentSummary: "targetSymbol is declared in src/feature.ts.",
      expectedAddedFiles: {},
      requiredActionNames: ["Grep"],
      retryCount: 0,
      permissionPreset: "full_access",
      approvalDecision: null,
    }),
    caseDefinition({
      id: "controlled-file-write",
      scenario: "controlled_file_write",
      prompt: "Create src/generated.txt containing phase26 followed by a newline.",
      fixtureFiles: {
        "src/existing.txt": "existing\n",
      },
      outputs: [
        {
          kind: "tool_call",
          toolName: "Write",
          reason: "Create the requested generated file.",
          input: {
            file_path: "src/generated.txt",
            content: "phase26\n",
          },
        },
        {
          kind: "completion",
          summary: "Created the requested generated file.",
        },
      ],
      productStatus: "completed",
      runStatus: "succeeded",
      agentSummary: "Created the requested generated file.",
      expectedAddedFiles: { "src/generated.txt": "phase26\n" },
      requiredActionNames: ["Write"],
      retryCount: 0,
      permissionPreset: "full_access",
      approvalDecision: null,
    }),
    caseDefinition({
      id: "denied-command",
      scenario: "denied_command",
      prompt: "Run a command that would create denied.txt.",
      fixtureFiles: {
        "README.md": "The command must remain denied.\n",
      },
      outputs: [
        {
          kind: "tool_call",
          reason: "Attempt the requested command under permission control.",
          toolName: process.platform === "win32" ? "PowerShell" : "Bash",
          input: {
            command: process.platform === "win32"
              ? "[System.IO.File]::WriteAllText('denied.txt', 'must-not-exist')"
              : "printf 'must-not-exist' > 'denied.txt'",
            timeout_ms: 1_000,
            description: "Create the requested marker.",
          },
        },
        { kind: "stop", reason: "The requested command was denied." },
      ],
      productStatus: "cancelled",
      runStatus: "cancelled",
      agentSummary: null,
      expectedAddedFiles: {},
      requiredActionNames: [process.platform === "win32" ? "PowerShell" : "Bash"],
      retryCount: 0,
      permissionPreset: "approve_for_me",
      approvalDecision: "decline",
    }),
    caseDefinition({
      id: "malformed-output-retry",
      scenario: "malformed_output_retry",
      prompt: "Summarize the fixture after recovering from malformed output.",
      fixtureFiles: {
        "status.txt": "ready\n",
      },
      outputs: [
        fakeNativeProviderResult({
          kind: "failed",
          failure: {
            category: "transport",
            code: "provider_response_interrupted",
            message: "The response stream ended before a complete native Model Turn arrived.",
            retryAfterMs: 0,
            metadata: {},
          },
        }),
        { kind: "completion", summary: "Recovered from an interrupted Provider response." },
      ],
      productStatus: "completed",
      runStatus: "succeeded",
      agentSummary: "Recovered from an interrupted Provider response.",
      expectedAddedFiles: {},
      requiredActionNames: [],
      retryCount: 1,
      permissionPreset: "full_access",
      approvalDecision: null,
    }),
    caseDefinition({
      id: "multi-file-mutation",
      scenario: "multi_file_mutation",
      prompt: "Create alpha.txt and beta.txt with their declared contents.",
      fixtureFiles: {},
      outputs: [
        {
          kind: "tool_call",
          toolName: "Write",
          reason: "Create the first requested file.",
          input: { file_path: "alpha.txt", content: "alpha\n" },
        },
        {
          kind: "tool_call",
          toolName: "Write",
          reason: "Create the second requested file.",
          input: { file_path: "beta.txt", content: "beta\n" },
        },
        { kind: "completion", summary: "Created both requested files." },
      ],
      productStatus: "completed",
      runStatus: "succeeded",
      agentSummary: "Created both requested files.",
      expectedAddedFiles: { "alpha.txt": "alpha\n", "beta.txt": "beta\n" },
      requiredActionNames: ["Write"],
      retryCount: 0,
      permissionPreset: "full_access",
      approvalDecision: null,
      verificationTargets: [
        exactFileTarget("alpha", "alpha.txt", "alpha\n"),
        exactFileTarget("beta", "beta.txt", "beta\n"),
      ],
    }),
    caseDefinition({
      id: "ordinary-shell-verification",
      scenario: "ordinary_shell_verification",
      prompt: "Run one ordinary command as a test Verification check.",
      fixtureFiles: {},
      outputs: [
        {
          kind: "tool_call",
          toolName: shellTool,
          reason: "Run the requested command and interpret its settled result.",
          input: {
            command: process.platform === "win32"
              ? "Write-Output 'verification-ok'"
              : "printf 'verification-ok\\n'",
            verification_claim: "tests",
          },
        },
        { kind: "completion", summary: "The ordinary command check passed." },
      ],
      productStatus: "completed",
      runStatus: "succeeded",
      agentSummary: "The ordinary command check passed.",
      expectedAddedFiles: {},
      requiredActionNames: [shellTool],
      retryCount: 0,
      permissionPreset: "full_access",
      approvalDecision: null,
    }),
    caseDefinition({
      id: "failed-check-recovery",
      scenario: "failed_check_recovery",
      prompt: "Recover from one failed test command and validate the corrected state.",
      fixtureFiles: {},
      outputs: [
        {
          kind: "tool_call",
          toolName: shellTool,
          reason: "Observe the initial failing check.",
          input: {
            command: process.platform === "win32"
              ? "Write-Error 'expected failure'; exit 1"
              : "printf 'expected failure\\n' >&2; exit 1",
            verification_claim: "tests",
          },
        },
        {
          kind: "tool_call",
          toolName: shellTool,
          reason: "Run the corrected check.",
          input: {
            command: process.platform === "win32"
              ? "Write-Output 'recovered'"
              : "printf 'recovered\\n'",
            verification_claim: "tests",
          },
        },
        { kind: "completion", summary: "Recovered and completed the current check." },
      ],
      productStatus: "completed",
      runStatus: "succeeded",
      agentSummary: "Recovered and completed the current check.",
      expectedAddedFiles: {},
      requiredActionNames: [shellTool],
      retryCount: 0,
      permissionPreset: "full_access",
      approvalDecision: null,
    }),
    caseDefinition({
      id: "stale-evidence",
      scenario: "stale_evidence",
      prompt: "Replace tracked.txt, then propose completion.",
      fixtureFiles: { "tracked.txt": "original\n" },
      outputs: [
        {
          kind: "tool_call",
          toolName: "Write",
          reason: "Replace the tracked file.",
          input: { file_path: "tracked.txt", content: "changed\n" },
        },
        { kind: "completion", summary: "Replaced the tracked file." },
        { kind: "completion", summary: "Replaced the tracked file." },
        { kind: "completion", summary: "Replaced the tracked file." },
        { kind: "completion", summary: "Replaced the tracked file." },
        { kind: "completion", summary: "Replaced the tracked file." },
        { kind: "completion", summary: "Replaced the tracked file." },
        { kind: "completion", summary: "Replaced the tracked file." },
        { kind: "completion", summary: "Replaced the tracked file." },
      ],
      productStatus: "cancelled",
      runStatus: "cancelled",
      agentSummary: null,
      expectedAddedFiles: { "tracked.txt": "changed\n" },
      requiredActionNames: ["Write"],
      retryCount: 0,
      permissionPreset: "full_access",
      approvalDecision: null,
      verificationTargets: [exactFileTarget("tracked-original", "tracked.txt", "original\n")],
    }),
    caseDefinition({
      id: "premature-completion",
      scenario: "premature_completion",
      prompt: "Create required.txt containing ready followed by a newline.",
      fixtureFiles: {},
      outputs: [
        { kind: "completion", summary: "The requested file is ready." },
        { kind: "completion", summary: "The requested file is ready." },
        { kind: "completion", summary: "The requested file is ready." },
        { kind: "completion", summary: "The requested file is ready." },
        { kind: "completion", summary: "The requested file is ready." },
        { kind: "completion", summary: "The requested file is ready." },
        { kind: "completion", summary: "The requested file is ready." },
        { kind: "completion", summary: "The requested file is ready." },
      ],
      productStatus: "cancelled",
      runStatus: "cancelled",
      agentSummary: null,
      expectedAddedFiles: {},
      requiredActionNames: [],
      retryCount: 0,
      permissionPreset: "full_access",
      approvalDecision: null,
      verificationTargets: [exactFileTarget("required", "required.txt", "ready\n")],
    }),
  ].sort((left, right) => left.definition.ref.id.localeCompare(right.definition.ref.id));
}

function caseDefinition(input: {
  readonly id: string;
  readonly scenario: HelarcEvaluationScenario;
  readonly prompt: string;
  readonly fixtureFiles: Readonly<Record<string, string>>;
  readonly outputs: readonly unknown[];
  readonly productStatus: HelarcEvaluationExpectedClaim["productStatus"];
  readonly runStatus: HelarcEvaluationExpectedClaim["runStatus"];
  readonly agentSummary: string | null;
  readonly expectedAddedFiles: Readonly<Record<string, string>>;
  readonly requiredActionNames: readonly string[];
  readonly retryCount: number;
  readonly permissionPreset: HelarcEvaluationPermissionPreset;
  readonly approvalDecision: "decline" | null;
  readonly verificationTargets?: readonly HelarcExactTargetVerificationRequirement[];
}): HelarcEvaluationCaseDefinition {
  const caseRef = ref(`helarc.phase26.case.${input.id}`);
  const caseFixture = createFixture(
    `helarc.phase26.fixture.${input.id}`,
    input.fixtureFiles,
  );
  const scriptRef = ref(`helarc.phase26.script.${input.id}`);
  const claimRef = ref(`helarc.phase26.claim.${input.id}`);
  const definition = createEvaluationCase({
    ref: caseRef,
    name: input.id,
    targetInput: {
      scenario: input.scenario,
      taskText: input.prompt,
      scriptRef: scriptRef.id,
    },
    fixtureRefs: [caseFixture.ref, scriptRef],
    expectedClaimRefs: [claimRef],
    criterionRefs: [REFS.outcomeCriterion, REFS.safetyCriterion],
    graderRefs: [REFS.outcomeGrader, REFS.safetyGrader],
    budget: {
      maximumDurationMs: 30_000,
      maximumCost: 0,
      maximumTokens: 1_000,
      maximumOperations: 16,
    },
    distributionKey: "phase26-deterministic",
    pairingKey: `pair.${input.id}`,
    partition: { purpose: "regression", visibility: "public" },
    provenance: corpusProvenance(),
    validity: { validFrom: HELARC_EVALUATION_TIME, validUntil: null },
    supersedes: null,
    createdAt: HELARC_EVALUATION_TIME,
    metadata: { scenario: input.scenario },
    limitations: [systemBaselineLimitation()],
  });
  const workspaceFiles = mergeFixtureFiles(
    caseFixture.files,
    input.expectedAddedFiles,
  );
  const script: HelarcEvaluationScript = Object.freeze({
    ref: scriptRef,
    steps: Object.freeze(input.outputs.map((output, index) =>
      scriptedStep(output, index + 1))),
    permissionPreset: input.permissionPreset,
  });
  const expectedClaim: HelarcEvaluationExpectedClaim = Object.freeze({
    ref: claimRef,
    caseRef,
    productStatus: input.productStatus,
    runStatus: input.runStatus,
    agentSummary: input.agentSummary,
    workspaceFiles,
    requiredActionNames: Object.freeze([...input.requiredActionNames].sort()),
    retryCount: input.retryCount,
    approvalDecision: input.approvalDecision,
  });
  return Object.freeze({
    scenario: input.scenario,
    definition,
    fixture: caseFixture,
    script,
    expectedClaim,
    verificationTargets: Object.freeze([...(input.verificationTargets ?? [])]),
  });
}

function exactFileTarget(
  id: string,
  path: string,
  content: string,
): HelarcExactTargetVerificationRequirement {
  const digest = `sha256:${sha256(content)}`;
  return Object.freeze({
    target: Object.freeze({
      ref: Object.freeze({
        owner: "helarc.code-workspace",
        kind: "target_state",
        id,
        revision: "v1",
      }),
      expected: Object.freeze({
        target: Object.freeze({
          rootName: "primary",
          workspaceId: "evaluation-workspace",
          path,
        }),
        baseline: Object.freeze({
          kind: "present" as const,
          entryKind: "file" as const,
          objectIdentity: Object.freeze({
            kind: "posix" as const,
            deviceId: "evaluation",
            inode: id,
          }),
          contentDigest: digest,
        }),
        content,
        contentRef: Object.freeze({
          algorithm: "sha256" as const,
          digest,
          byteLength: Buffer.byteLength(content, "utf8"),
        }),
        capturedAt: HELARC_EVALUATION_TIME,
      }),
      maxContentBytes: 64 * 1024,
    }),
    necessity: "mandatory",
    claim: `The exact current content of '${path}' matches the required state.`,
    purpose: "Prevent completion from relying on absent or stale target state.",
  });
}

function createCriteria(): EvaluationCriterion[] {
  return [
    createEvaluationCriterion({
      ref: REFS.outcomeCriterion,
      name: "Expected externally observable behavior",
      description: "The Product, Run, Actions, Retry behavior, review outcome, and final Workspace match the exact Case claim.",
      dimension: "outcome_quality",
      valueSchema: { kind: "boolean" },
      createdAt: HELARC_EVALUATION_TIME,
      metadata: {},
      limitations: [systemBaselineLimitation()],
    }),
    createEvaluationCriterion({
      ref: REFS.safetyCriterion,
      name: "Workspace and authority isolation",
      description: "The Trial changes only declared Workspace files through canonical execution and preserves denied effects.",
      dimension: "safety",
      valueSchema: { kind: "boolean" },
      createdAt: HELARC_EVALUATION_TIME,
      metadata: {},
      limitations: [systemBaselineLimitation()],
    }),
  ];
}

function createGraders(): EvaluationGraderDefinition[] {
  return [
    createEvaluationGraderDefinition({
      ref: REFS.outcomeGrader,
      name: "Helarc expected-claim reference grader",
      kind: "reference",
      criterionRef: REFS.outcomeCriterion,
      rubricRef: ref("helarc.phase26.rubric.outcome"),
      requiredSlots: [
        graderSlot("product-outcome"),
        graderSlot("run-terminal"),
        graderSlot("workspace-after"),
        graderSlot("interaction-review"),
        graderSlot("trace-summary"),
      ],
      outputSchemaRef: schema("helarc.phase26.grade.boolean"),
      calibrationRefs: [ref("helarc.phase26.calibration.outcome")],
      validity: { validFrom: HELARC_EVALUATION_TIME, validUntil: null },
      disclosure: "internal",
      dataResidency: "local-process",
      requireActorAttribution: false,
      requireModelAttribution: false,
      createdAt: HELARC_EVALUATION_TIME,
      metadata: {},
      limitations: [systemBaselineLimitation()],
    }),
    createEvaluationGraderDefinition({
      ref: REFS.safetyGrader,
      name: "Helarc deterministic isolation grader",
      kind: "deterministic",
      criterionRef: REFS.safetyCriterion,
      rubricRef: ref("helarc.phase26.rubric.safety"),
      requiredSlots: [
        graderSlot("workspace-before"),
        graderSlot("workspace-after"),
        graderSlot("interaction-review"),
        graderSlot("trace-summary"),
      ],
      outputSchemaRef: schema("helarc.phase26.grade.boolean"),
      calibrationRefs: [ref("helarc.phase26.calibration.safety")],
      validity: { validFrom: HELARC_EVALUATION_TIME, validUntil: null },
      disclosure: "internal",
      dataResidency: "local-process",
      requireActorAttribution: false,
      requireModelAttribution: false,
      createdAt: HELARC_EVALUATION_TIME,
      metadata: {},
      limitations: [systemBaselineLimitation()],
    }),
  ];
}

function createMetrics(): EvaluationMetricDefinition[] {
  return [
    gradeMetric({
      ref: REFS.outcomeMetric,
      name: "Expected behavior pass rate",
      criterionRef: REFS.outcomeCriterion,
      dimension: "outcome_quality",
      role: "gate",
    }),
    gradeMetric({
      ref: REFS.safetyMetric,
      name: "Safety and isolation pass rate",
      criterionRef: REFS.safetyCriterion,
      dimension: "safety",
      role: "gate",
    }),
    measurementMetric({
      ref: REFS.latencyMetric,
      name: "Logical target latency",
      dimension: "efficiency",
      measurementId: "latency_ms",
      owner: "runtime",
      unit: "ms",
    }),
    measurementMetric({
      ref: REFS.retryMetric,
      name: "Structured-output Retry count",
      dimension: "trajectory",
      measurementId: "retry_count",
      owner: "agent-core",
      unit: "count",
    }),
  ];
}

function createCapturePolicy(): EvaluationCapturePolicy {
  const graderConsumers = [
    { kind: "grader" as const, ref: REFS.outcomeGrader },
    { kind: "grader" as const, ref: REFS.safetyGrader },
  ];
  return createEvaluationCapturePolicy({
    ref: REFS.capturePolicy,
    slots: [
      captureSlot("product-outcome", "helarc.product", true, graderConsumers),
      captureSlot("run-terminal", "agent-core", true, graderConsumers),
      captureSlot("workspace-before", "workspace", true, graderConsumers),
      captureSlot("workspace-after", "workspace", true, graderConsumers),
      captureSlot("artifact-observations", "agent-core", true, graderConsumers),
      captureSlot("interaction-review", "helarc.product", true, graderConsumers),
      captureSlot("trace-summary", "observability", true, graderConsumers),
      captureSlot("verification-summary", "verification", true, []),
      captureSlot("tool-exposure-summary", "agent-core", true, []),
    ],
    createdAt: HELARC_EVALUATION_TIME,
    metadata: { product: "helarc", corpusRevision: HELARC_EVALUATION_CORPUS_REVISION },
    limitations: [
      systemBaselineLimitation(),
    ],
  });
}

function gradeMetric(input: {
  readonly ref: EvaluationRecordRef;
  readonly name: string;
  readonly criterionRef: EvaluationRecordRef;
  readonly dimension: "outcome_quality" | "safety";
  readonly role: "gate";
}): EvaluationMetricDefinition {
  return createEvaluationMetricDefinition({
    ref: input.ref,
    name: input.name,
    dimension: input.dimension,
    source: { kind: "grade", criterionRef: input.criterionRef },
    unit: "ratio",
    aggregation: "rate",
    requiredTrialStatuses: ["completed"],
    requiredCaptureStatuses: ["complete"],
    requiredGradingStatuses: ["graded"],
    uncertainty: { method: "wilson", confidence: 0.95, minimumSamples: 2 },
    exclusionCodes: [],
    pairedComparisonKey: "case-and-repetition",
    direction: "higher",
    role: input.role,
    gateThreshold: { comparison: "at_least", value: 1 },
    createdAt: HELARC_EVALUATION_TIME,
    metadata: {},
    limitations: [systemBaselineLimitation()],
  });
}

function measurementMetric(input: {
  readonly ref: EvaluationRecordRef;
  readonly name: string;
  readonly dimension: "efficiency" | "trajectory";
  readonly measurementId: string;
  readonly owner: string;
  readonly unit: string;
}): EvaluationMetricDefinition {
  return createEvaluationMetricDefinition({
    ref: input.ref,
    name: input.name,
    dimension: input.dimension,
    source: {
      kind: "measurement",
      measurementId: input.measurementId,
      owner: input.owner,
    },
    unit: input.unit,
    aggregation: "numeric_distribution",
    requiredTrialStatuses: ["completed"],
    requiredCaptureStatuses: ["complete"],
    requiredGradingStatuses: [],
    uncertainty: { method: "standard_error", confidence: 0.95, minimumSamples: 2 },
    exclusionCodes: [],
    pairedComparisonKey: "case-and-repetition",
    direction: "lower",
    role: "informational",
    gateThreshold: null,
    createdAt: HELARC_EVALUATION_TIME,
    metadata: {},
    limitations: [systemBaselineLimitation()],
  });
}

function captureSlot(
  id: string,
  owner: string,
  required: boolean,
  consumers: readonly { readonly kind: "grader"; readonly ref: EvaluationRecordRef }[],
) {
  return {
    id,
    owner,
    schemaRef: schema(`helarc.phase26.capture.${id}`),
    required,
    maximumSensitivity: "internal" as const,
    contentMode: "inline" as const,
    retention: "baseline" as const,
    maximumBytes: 64 * 1024,
    optionalOmission: "complete" as const,
    consumers,
  };
}

function graderSlot(slotId: string) {
  return { slotId, schemaRef: schema(`helarc.phase26.capture.${slotId}`) };
}

function requirement(key: string, owner: string, required = true) {
  return {
    key,
    owner,
    required,
    schemaRef: schema(`helarc.phase26.input.${key}`),
    maximumSensitivity: required ? "public" as const : "internal" as const,
    description: `Exact admitted behavior input for ${key}.`,
  };
}

function createFixture(
  id: string,
  files: Readonly<Record<string, string>>,
): HelarcEvaluationFixture {
  return Object.freeze({
    ref: ref(id),
    files: fileRecords(files),
  });
}

function mergeFixtureFiles(
  base: readonly HelarcEvaluationFixtureFile[],
  additions: Readonly<Record<string, string>>,
): readonly HelarcEvaluationFixtureFile[] {
  const merged = Object.fromEntries(base.map((file) => [file.path, file.content]));
  for (const [path, content] of Object.entries(additions)) merged[path] = content;
  return fileRecords(merged);
}

function fileRecords(
  files: Readonly<Record<string, string>>,
): readonly HelarcEvaluationFixtureFile[] {
  return Object.freeze(Object.entries(files)
    .map(([path, content]) => Object.freeze({
      path,
      content,
      sha256: sha256(content),
      bytes: Buffer.byteLength(content, "utf8"),
    }))
    .sort((left, right) => left.path.localeCompare(right.path)));
}

function scriptedStep(output: unknown, sequence: number): FakeNativeToolProviderStep {
  if (isFakeNativeToolProviderStep(output)) return output;
  const inputTokens = 10 + sequence;
  const outputTokens = 4 + sequence;
  return fakeNativeModelOutput(output, {
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      costUnits: null,
      metadata: { source: "deterministic-script" },
    },
    metadata: { scriptSequence: sequence },
  });
}

function isFakeNativeToolProviderStep(value: unknown): value is FakeNativeToolProviderStep {
  return typeof value === "object" && value !== null && "kind" in value &&
    (value.kind === "model_output" || value.kind === "provider_result");
}

function corpusProvenance() {
  return {
    source: "agent-anything Phase26 deterministic corpus",
    sourceRevision: HELARC_EVALUATION_CORPUS_REVISION,
    license: "Apache-2.0",
    metadata: { bundledThirdPartyData: false },
  };
}

function systemBaselineLimitation(): EvaluationLimitation {
  return limitation(
    "deterministic_system_baseline_only",
    "This corpus measures deterministic Product and Harness integration, not general model intelligence.",
  );
}

function limitation(code: string, message: string): EvaluationLimitation {
  return Object.freeze({ code, message, metadata: Object.freeze({}) });
}

function ref(id: string, revision = "v1"): EvaluationRecordRef {
  return Object.freeze({ id, revision });
}

function schema(schemaId: string): EvaluationSchemaRef {
  return Object.freeze({ schemaId, revision: "v1" });
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

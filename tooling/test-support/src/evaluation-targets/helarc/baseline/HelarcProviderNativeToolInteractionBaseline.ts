import type {
  HelarcEvaluationBaselineMetricSignature,
  HelarcEvaluationBaselineSignature,
} from "../HelarcEvaluationExecution.js";
import {
  HELARC_VERIFICATION_GUIDED_COMPLETION_ACCEPTED_BASELINE,
} from "./HelarcVerificationGuidedCompletionBaseline.js";

const TARGET_MANIFEST_DIGEST = "7c737029da2a884bcf75de31d7f98f30d2792f15bf24caede34be0551340eeeb";
const TARGET_REVISION =
  HELARC_VERIFICATION_GUIDED_COMPLETION_ACCEPTED_BASELINE.targetSnapshotRef.revision
    .replace(/^v11-/, "v12-");
const TARGET_REF = Object.freeze({
  id: HELARC_VERIFICATION_GUIDED_COMPLETION_ACCEPTED_BASELINE.targetSnapshotRef.id,
  revision: TARGET_REVISION,
});
const CAMPAIGN_REF = Object.freeze({
  id: HELARC_VERIFICATION_GUIDED_COMPLETION_ACCEPTED_BASELINE.campaignRef.id,
  revision: "v3",
});
const REPORT_REF = Object.freeze({
  id: "helarc.provider-native-tool-interaction.report.baseline",
  revision: TARGET_REVISION,
});
const ACCEPTANCE_REF = Object.freeze({
  id: "helarc.provider-native-tool-interaction.baseline-acceptance",
  revision: TARGET_REVISION,
});

const CASE_DIGEST_BY_KEY = Object.freeze<Record<string, string>>({
  "controlled-file-write:1": "24bb17da4874cc2db41234f86151e7653d7e3756c468624080dd8114fd0263a2",
  "controlled-file-write:2": "25bc52bc40f9df05d2393af995bc6f9f85d5aa2cc9f4c8c4f515c7569ca3eaf1",
  "denied-command:1": "3d1047237be2c2ea0016c2a3ffc61a0e296c8e028909db3a58eadaa830ca8b25",
  "denied-command:2": "6f1ee3d3e263c369b5f054dd76db0f9a9ac09c4e3a3b6b4ce56ce09f57493429",
  "failed-check-recovery:1": "71c73f28aa69e9645841368728984e1a65368631edeef6798810f013a42d1a5a",
  "failed-check-recovery:2": "cc2211b56d8b94f1aa8361739b2689f640781584b79881c21b532bc4230865fb",
  "inspect-and-complete:1": "8601e1aba4bb5e94e35825437526700bc45062ebe4ff92696f3fb4875c29087d",
  "inspect-and-complete:2": "ad9f196aba4873238a9c8860dc4ff2c593875e56c0b3313d199899e4fc7a7ea1",
  "malformed-output-retry:1": "1526f7c40dabb2d744f7b6f5e99052f2c6c568e8808a64cc77c0703dfb6b4226",
  "malformed-output-retry:2": "ec4944d9aba423ea00c6ffb5006afbfc1475f40bdf86f803cab43d17c385fb90",
  "multi-file-mutation:1": "9f1b9d80ee86b36ddee1acbb07e756015b695521ee324de9a307bc8e79e3a758",
  "multi-file-mutation:2": "58b85ca6a8be907713f146a45fa254a6a0274448df8ccfbd64064e162f3ac132",
  "ordinary-shell-verification:1": "830791fdf9178327e1d10e0a3385e771fa19f5629c2873fbd540fe3d39ccda55",
  "ordinary-shell-verification:2": "70ab137e88204840842b60d27270c036cfe149f0e5e7e4a7ca40725fcba19c71",
  "premature-completion:1": "edcd45e413ae8dea2929e32f3f8c42bb9dd02bcad582b9bea5f33bc09515ad3f",
  "premature-completion:2": "e413f4a5993d9da855d8fd40aaefec523b7e11fb1fa3be4b38fef19be98bfde7",
  "search:1": "94dd60dcd44157413912e01cf46828ac5c81d3ef7ab909967f5445ed21228456",
  "search:2": "0c83355bb769f3bbe4eaeb7ce97f718886b9e31f1fd74bf6c926ddccdac76b2a",
  "stale-evidence:1": "55f11f3adc73679f8291912b07a9dfd8b537b77176855581f371195ebbfee928",
  "stale-evidence:2": "b4bbad50e0e2031a019d3a4b45e7d00ccd66c188f3f2bcb2f230b804d3135c56",
});

const LATENCY_BY_CASE = Object.freeze<Record<string, number>>({
  "controlled-file-write": 95,
  "denied-command": 108,
  "failed-check-recovery": 163,
  "inspect-and-complete": 141,
  "malformed-output-retry": 57,
  "multi-file-mutation": 206,
  "ordinary-shell-verification": 104,
  "premature-completion": 216,
  search: 94,
  "stale-evidence": 282,
});

const LATENCY_DISTRIBUTION = Object.freeze({
  kind: "numeric_distribution" as const,
  sampleCount: 20,
  minimum: 57,
  maximum: 282,
  mean: 146.6,
  variance: 4604.252631578946,
  varianceMethod: "sample" as const,
  p50: 124.5,
  p90: 222.60000000000008,
  p95: 282,
});

const LATENCY_UNCERTAINTY = Object.freeze({
  status: "available" as const,
  method: "standard_error" as const,
  confidence: 0.95,
  lower: 116.86193776252225,
  upper: 176.33806223747774,
});

const metrics = HELARC_VERIFICATION_GUIDED_COMPLETION_ACCEPTED_BASELINE.metrics.map(
  (metric) => {
    const latency = metric.definitionRef.id.endsWith(".latency");
    return Object.freeze({
      ...metric,
      ref: providerNativeMetricResultRef(metric.ref),
      targetSnapshotRef: TARGET_REF,
      samples: Object.freeze(metric.samples.map((sample) => Object.freeze({
        ...sample,
        value: latency ? latencyForCase(sample.caseRef.id) : sample.value,
      }))),
      distribution: latency ? LATENCY_DISTRIBUTION : metric.distribution,
      uncertainty: latency ? LATENCY_UNCERTAINTY : metric.uncertainty,
    }) satisfies HelarcEvaluationBaselineMetricSignature;
  },
);

export const HELARC_PROVIDER_NATIVE_TOOL_INTERACTION_ACCEPTED_BASELINE = deepFreeze({
  ...HELARC_VERIFICATION_GUIDED_COMPLETION_ACCEPTED_BASELINE,
  corpusRevision: "helarc-provider-native-tool-interaction-corpus-v1",
  targetSnapshotRef: TARGET_REF,
  targetManifestDigest: TARGET_MANIFEST_DIGEST,
  campaignRef: CAMPAIGN_REF,
  reportRef: REPORT_REF,
  acceptanceRef: ACCEPTANCE_REF,
  publication: {
    ...HELARC_VERIFICATION_GUIDED_COMPLETION_ACCEPTED_BASELINE.publication,
    reportRef: REPORT_REF,
    targetSnapshotRefs: Object.freeze([TARGET_REF]),
    metricSummaries:
      HELARC_VERIFICATION_GUIDED_COMPLETION_ACCEPTED_BASELINE.publication.metricSummaries.map(
        (summary) => {
          const metricRef = providerNativeMetricResultRef(summary.metricRef);
          const metric = metrics.find((candidate) => candidate.ref.id === metricRef.id);
          if (metric === undefined) throw new TypeError(`Unknown successor Metric '${metricRef.id}'.`);
          return Object.freeze({
            ...summary,
            metricRef,
            distribution: metric.distribution,
            uncertainty: metric.uncertainty,
          });
        },
      ),
    dimensionSummaries:
      HELARC_VERIFICATION_GUIDED_COMPLETION_ACCEPTED_BASELINE.publication.dimensionSummaries.map(
        (summary) => Object.freeze({
          ...summary,
          metricRefs: Object.freeze(summary.metricRefs.map(providerNativeMetricResultRef)),
        }),
      ),
    gateOutcomes:
      HELARC_VERIFICATION_GUIDED_COMPLETION_ACCEPTED_BASELINE.publication.gateOutcomes.map(
        (outcome) => Object.freeze({
          ...outcome,
          metricRef: providerNativeMetricResultRef(outcome.metricRef),
        }),
      ),
  },
  metrics: Object.freeze(metrics),
  cases: Object.freeze(
    HELARC_VERIFICATION_GUIDED_COMPLETION_ACCEPTED_BASELINE.cases.map((item) =>
      Object.freeze({
        ...item,
        semanticDigest: digestForCase(item.caseRef.id, item.repetitionOrdinal),
      })
    ),
  ),
  providerNativeToolInteraction: Object.freeze({
    targetAdapterRevision: "helarc-provider-native-tool-interaction-target-v1",
    controllerProtocolRevision: "helarc.provider-native-tool-interaction.v1",
    controllerControlSetRevision: "helarc.controller-controls.v1",
    runInteractionRecordsRevision: "model-turn-and-settlement.v1",
  }),
} satisfies HelarcEvaluationBaselineSignature & {
  readonly providerNativeToolInteraction: {
    readonly targetAdapterRevision: string;
    readonly controllerProtocolRevision: string;
    readonly controllerControlSetRevision: string;
    readonly runInteractionRecordsRevision: string;
  };
});

export const HELARC_PROVIDER_NATIVE_TOOL_INTERACTION_BASELINE_ACCEPTANCE = deepFreeze({
  schemaVersion: 1,
  kind: "helarc_provider_native_tool_interaction_baseline_successor_acceptance",
  acceptedAt: "2026-08-27T00:00:00.000Z",
  predecessorAcceptanceRef:
    HELARC_VERIFICATION_GUIDED_COMPLETION_ACCEPTED_BASELINE.acceptanceRef,
  successorAcceptanceRef: ACCEPTANCE_REF,
  predecessorReportRef: HELARC_VERIFICATION_GUIDED_COMPLETION_ACCEPTED_BASELINE.reportRef,
  successorReportRef: REPORT_REF,
  comparison: "intentionally_incomparable_exact_target",
  changedTargetInputs: Object.freeze([
    "product.revision",
    "prompt.revision",
    "controller-protocol.revision",
    "controller-control-set.revision",
    "model-interaction.protocol.revision",
    "run-interaction-records.revision",
    "target-adapter.revision",
    "source.revision",
    "provider.revision",
    "model.revision",
    "fixture-manifest.revision",
    "expected-claims.revision",
  ]),
  outcomeQuality: "passed",
  safety: "passed",
  reliability: "deterministic_candidate_repeated_equivalently",
  trajectory:
    "Native Model Turns and explicit call settlement replace opaque Product decisions while preserving accepted outcomes, safety gates, Retry behavior, completion truth, and recursive delegation.",
  coverage:
    "The successor records exact Provider-native interaction, Controller controls, request-local callable binding, Run-owned settlement evidence, and twenty paired deterministic Case executions.",
  limitations: "deterministic_system_case_only",
});

function providerNativeMetricResultRef(refValue: {
  readonly id: string;
  readonly revision: string;
}) {
  if (!refValue.id.endsWith(".verification-guided-completion-baseline-result")) {
    throw new TypeError(`Unknown predecessor Metric result '${refValue.id}'.`);
  }
  return Object.freeze({
    id: refValue.id.replace(
      /\.verification-guided-completion-baseline-result$/,
      ".provider-native-tool-interaction-baseline-result",
    ),
    revision: TARGET_REVISION,
  });
}

function latencyForCase(caseId: string): number {
  const marker = ".case.";
  const index = caseId.lastIndexOf(marker);
  if (index < 0) throw new TypeError(`Unknown predecessor Case '${caseId}'.`);
  const value = LATENCY_BY_CASE[caseId.slice(index + marker.length)];
  if (value === undefined) throw new TypeError(`Unknown latency Case '${caseId}'.`);
  return value;
}

function digestForCase(caseId: string, repetitionOrdinal: number): string {
  const marker = ".case.";
  const index = caseId.lastIndexOf(marker);
  if (index < 0) throw new TypeError(`Unknown predecessor Case '${caseId}'.`);
  const key = `${caseId.slice(index + marker.length)}:${repetitionOrdinal}`;
  const digest = CASE_DIGEST_BY_KEY[key];
  if (digest === undefined) throw new TypeError(`Unknown Provider-native Case '${key}'.`);
  return digest;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

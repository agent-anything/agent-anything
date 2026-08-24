import type {
  HelarcEvaluationBaselineMetricSignature,
  HelarcEvaluationBaselineSignature,
} from "../HelarcEvaluationExecution.js";
import { HELARC_RUN_PROGRESS_ACCEPTED_BASELINE } from "./HelarcRunProgressBaseline.js";

const TARGET_MANIFEST_DIGEST = "47051ffd390dda402d89c1447f88d7cf9821293761863d55ba55c38e4c5c6a4e";
const TARGET_REVISION = HELARC_RUN_PROGRESS_ACCEPTED_BASELINE.targetSnapshotRef.revision
  .replace(/^v7-/, "v8-");
const TARGET_REF = Object.freeze({
  id: HELARC_RUN_PROGRESS_ACCEPTED_BASELINE.targetSnapshotRef.id,
  revision: TARGET_REVISION,
});
const REPORT_REF = Object.freeze({
  id: "helarc.current-turn-tool-exposure.report.baseline",
  revision: TARGET_REVISION,
});
const ACCEPTANCE_REF = Object.freeze({
  id: "helarc.current-turn-tool-exposure.baseline-acceptance",
  revision: TARGET_REVISION,
});

const CASE_DIGEST_BY_KEY = Object.freeze<Record<string, string>>({
  "controlled-file-write:1": "4e1b81a92ae17ce7beb27b10f4cbd58cc8c02c3c42db260f56067d4e14ab7946",
  "controlled-file-write:2": "7caf6a47064ba7a3a13e758e5ab34b2a17db7882a82551f0f81e00b9372a3207",
  "denied-command:1": "440317d5e74a9d0a9fa2b4f0d5d8bb88dd688a16aa617be626c196014dd9a65a",
  "denied-command:2": "1b309ff70412c3dac0edde46abbd9fec0b49423df54a85a43b21c992465c0652",
  "failed-check-recovery:1": "450906b52b875a61a46654b5f0eda01945bc2397e934db5d36bdbc3b18e9cb1e",
  "failed-check-recovery:2": "b8fd47b18de840709247ed48c656dcd856fd2a7258a3d2ea1cb3362aa5457d55",
  "inspect-and-complete:1": "0d646c6714e4907f0ea415e9f6f69e899a2c8314968971ad46f4ae2adee051a4",
  "inspect-and-complete:2": "8c2ae3d42b4c6b1074e8ef1efc9e6dcac8c6012531157423b3ffbf80b73e5b80",
  "malformed-output-retry:1": "db4c948b8b118b4dd8a23de9fa85486b366eb39f92e903f107c2aa1e4ec2ee1b",
  "malformed-output-retry:2": "5fb07b58010b78bfbf939f8a10df7a01d855465498928148d9ef9fdc550d14bd",
  "multi-file-mutation:1": "2bf8c035608da65dbcd4fcc335a914fa768a4083958762b3df15fdb611ef4e7e",
  "multi-file-mutation:2": "f6efcb30e2180393103164c9a90661fd223df1f30b77d1c7543fbf42e2f9365d",
  "ordinary-shell-validation:1": "4de603f250d27863e3661de085da472a926d28876d0ce062d54ef9658616f59c",
  "ordinary-shell-validation:2": "4367b0f07ef5efce1fcebe2d91fb77e1e14819bd7ad707cad4942015fed70e33",
  "premature-completion:1": "58bcc048670913f2a3b073042e66eed574884368c05912b56d1a1a4d8cb2f62d",
  "premature-completion:2": "e4553ddfde263a3956cf472875140f79ae5cb564995985a606682fd56d20aa02",
  "search:1": "009f6951e9e18ace54a030cc640996312a1b317e5c0ad0b6121df8cdef41f5c0",
  "search:2": "c6d201b6cfe40342a16b5c4557a104b629832687a54371b6107986e9f029cab7",
  "stale-evidence:1": "dfc28970868e3bd6f9cda77b838393bf2d98b08428648d3fb638b2de1e30e51c",
  "stale-evidence:2": "d1140541e464d30c8aec469ce943ae87ef171f4c4a8f415a364c74ed7fbad488",
});

const metrics = HELARC_RUN_PROGRESS_ACCEPTED_BASELINE.metrics.map((metric) =>
  Object.freeze({
    ...metric,
    ref: currentTurnMetricResultRef(metric.ref),
    targetSnapshotRef: TARGET_REF,
  }) satisfies HelarcEvaluationBaselineMetricSignature);

export const HELARC_CURRENT_TURN_TOOL_EXPOSURE_ACCEPTED_BASELINE = deepFreeze({
  ...HELARC_RUN_PROGRESS_ACCEPTED_BASELINE,
  corpusRevision: "helarc-current-turn-tool-exposure-corpus-v1",
  targetSnapshotRef: TARGET_REF,
  targetManifestDigest: TARGET_MANIFEST_DIGEST,
  reportRef: REPORT_REF,
  acceptanceRef: ACCEPTANCE_REF,
  publication: {
    ...HELARC_RUN_PROGRESS_ACCEPTED_BASELINE.publication,
    reportRef: REPORT_REF,
    targetSnapshotRefs: Object.freeze([TARGET_REF]),
    metricSummaries: HELARC_RUN_PROGRESS_ACCEPTED_BASELINE.publication.metricSummaries.map(
      (summary) => Object.freeze({
        ...summary,
        metricRef: currentTurnMetricResultRef(summary.metricRef),
      }),
    ),
    dimensionSummaries: HELARC_RUN_PROGRESS_ACCEPTED_BASELINE.publication.dimensionSummaries.map(
      (summary) => Object.freeze({
        ...summary,
        metricRefs: Object.freeze(summary.metricRefs.map(currentTurnMetricResultRef)),
      }),
    ),
    gateOutcomes: HELARC_RUN_PROGRESS_ACCEPTED_BASELINE.publication.gateOutcomes.map(
      (outcome) => Object.freeze({
        ...outcome,
        metricRef: currentTurnMetricResultRef(outcome.metricRef),
      }),
    ),
  },
  metrics: Object.freeze(metrics),
  cases: Object.freeze(HELARC_RUN_PROGRESS_ACCEPTED_BASELINE.cases.map((item) =>
    Object.freeze({
      ...item,
      semanticDigest: digestForCase(item.caseRef.id, item.repetitionOrdinal),
    }))),
} satisfies HelarcEvaluationBaselineSignature);

export const HELARC_CURRENT_TURN_TOOL_EXPOSURE_BASELINE_ACCEPTANCE = deepFreeze({
  schemaVersion: 1,
  kind: "helarc_current_turn_tool_exposure_baseline_successor_acceptance",
  acceptedAt: "2026-08-24T00:00:00.000Z",
  predecessorAcceptanceRef: HELARC_RUN_PROGRESS_ACCEPTED_BASELINE.acceptanceRef,
  successorAcceptanceRef: ACCEPTANCE_REF,
  predecessorReportRef: HELARC_RUN_PROGRESS_ACCEPTED_BASELINE.reportRef,
  successorReportRef: REPORT_REF,
  comparison: "intentionally_incomparable_exact_target",
  changedTargetInputs: Object.freeze([
    "product.revision",
    "target-adapter.revision",
    "source.revision",
    "tool-profile.revision",
    "fixture-manifest.revision",
    "expected-claims.revision",
  ]),
  outcomeQuality: "passed",
  safety: "passed",
  reliability: "deterministic_candidate_repeated_equivalently",
  trajectory:
    "All twenty deterministic Trials retain accepted outcome, safety, latency, Retry, and terminal semantics while Capture adds exact current-turn Tool Exposure lineage and counts.",
  coverage:
    "The accepted Product Suite is paired with focused current-turn exposure omission, recovery, Permission and Progress separation, stale-response, candidate-invalidation, and disclosure conformance.",
  limitations: "deterministic_system_baseline_only",
});

function currentTurnMetricResultRef(refValue: {
  readonly id: string;
  readonly revision: string;
}) {
  if (!refValue.id.endsWith(".run-progress-baseline-result")) {
    throw new TypeError(`Unknown predecessor Metric result '${refValue.id}'.`);
  }
  return Object.freeze({
    id: refValue.id.replace(
      /\.run-progress-baseline-result$/,
      ".current-turn-tool-exposure-baseline-result",
    ),
    revision: TARGET_REVISION,
  });
}

function digestForCase(caseId: string, repetitionOrdinal: number): string {
  const marker = ".case.";
  const index = caseId.lastIndexOf(marker);
  if (index < 0) throw new TypeError(`Unknown predecessor Case '${caseId}'.`);
  const key = `${caseId.slice(index + marker.length)}:${repetitionOrdinal}`;
  const digest = CASE_DIGEST_BY_KEY[key];
  if (digest === undefined) throw new TypeError(`Unknown Current-Turn Tool Exposure Case '${key}'.`);
  return digest;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

import type { HelarcEvaluationBaselineSignature } from "../HelarcEvaluationExecution.js";
import { HELARC_DESCENDANT_SUSPENSION_PROGRESSION_ACCEPTED_BASELINE as predecessor } from "./HelarcDescendantSuspensionProgressionBaseline.js";

const target = {"id":"helarc.phase26.target","revision":"v20-win32-x64-node24"};
const report = {"id":"helarc.normal-stop-settlement.report.baseline","revision":"v20-win32-x64-node24"};
const acceptance = {"id":"helarc.normal-stop-settlement.baseline-acceptance","revision":"v20-win32-x64-node24"};
const measuredMetrics = [
  {"ref":{"id":"helarc.phase26.metric.outcome-rate.normal-stop-settlement-baseline-result","revision":"v20-win32-x64-node24"},"definitionRef":{"id":"helarc.phase26.metric.outcome-rate","revision":"v1"},"distribution":{"kind":"rate","sampleCount":20,"positiveCount":20,"value":1},"uncertainty":{"status":"available","method":"wilson","confidence":0.95,"lower":0.83887484172924,"upper":1},"values":{"pair.controlled-file-write.rep-1":true,"pair.controlled-file-write.rep-2":true,"pair.denied-command.rep-1":true,"pair.denied-command.rep-2":true,"pair.failed-check-recovery.rep-1":true,"pair.failed-check-recovery.rep-2":true,"pair.inspect-and-complete.rep-1":true,"pair.inspect-and-complete.rep-2":true,"pair.malformed-output-retry.rep-1":true,"pair.malformed-output-retry.rep-2":true,"pair.multi-file-mutation.rep-1":true,"pair.multi-file-mutation.rep-2":true,"pair.ordinary-shell-verification.rep-1":true,"pair.ordinary-shell-verification.rep-2":true,"pair.premature-completion.rep-1":true,"pair.premature-completion.rep-2":true,"pair.search.rep-1":true,"pair.search.rep-2":true,"pair.stale-evidence.rep-1":true,"pair.stale-evidence.rep-2":true}},
  {"ref":{"id":"helarc.phase26.metric.safety-rate.normal-stop-settlement-baseline-result","revision":"v20-win32-x64-node24"},"definitionRef":{"id":"helarc.phase26.metric.safety-rate","revision":"v1"},"distribution":{"kind":"rate","sampleCount":20,"positiveCount":20,"value":1},"uncertainty":{"status":"available","method":"wilson","confidence":0.95,"lower":0.83887484172924,"upper":1},"values":{"pair.controlled-file-write.rep-1":true,"pair.controlled-file-write.rep-2":true,"pair.denied-command.rep-1":true,"pair.denied-command.rep-2":true,"pair.failed-check-recovery.rep-1":true,"pair.failed-check-recovery.rep-2":true,"pair.inspect-and-complete.rep-1":true,"pair.inspect-and-complete.rep-2":true,"pair.malformed-output-retry.rep-1":true,"pair.malformed-output-retry.rep-2":true,"pair.multi-file-mutation.rep-1":true,"pair.multi-file-mutation.rep-2":true,"pair.ordinary-shell-verification.rep-1":true,"pair.ordinary-shell-verification.rep-2":true,"pair.premature-completion.rep-1":true,"pair.premature-completion.rep-2":true,"pair.search.rep-1":true,"pair.search.rep-2":true,"pair.stale-evidence.rep-1":true,"pair.stale-evidence.rep-2":true}},
  {"ref":{"id":"helarc.phase26.metric.latency.normal-stop-settlement-baseline-result","revision":"v20-win32-x64-node24"},"definitionRef":{"id":"helarc.phase26.metric.latency","revision":"v1"},"distribution":{"kind":"numeric_distribution","sampleCount":20,"minimum":65,"maximum":210,"mean":134.5,"variance":2088.2631578947367,"varianceMethod":"sample","p50":124.5,"p90":203.70000000000002,"p95":210},"uncertainty":{"status":"available","method":"standard_error","confidence":0.95,"lower":114.47254766481757,"upper":154.52745233518243},"values":{"pair.controlled-file-write.rep-1":101,"pair.controlled-file-write.rep-2":101,"pair.denied-command.rep-1":108,"pair.denied-command.rep-2":108,"pair.failed-check-recovery.rep-1":164,"pair.failed-check-recovery.rep-2":164,"pair.inspect-and-complete.rep-1":145,"pair.inspect-and-complete.rep-2":145,"pair.malformed-output-retry.rep-1":65,"pair.malformed-output-retry.rep-2":65,"pair.multi-file-mutation.rep-1":210,"pair.multi-file-mutation.rep-2":210,"pair.ordinary-shell-verification.rep-1":110,"pair.ordinary-shell-verification.rep-2":110,"pair.premature-completion.rep-1":139,"pair.premature-completion.rep-2":139,"pair.search.rep-1":100,"pair.search.rep-2":100,"pair.stale-evidence.rep-1":203,"pair.stale-evidence.rep-2":203}},
  {"ref":{"id":"helarc.phase26.metric.retry-count.normal-stop-settlement-baseline-result","revision":"v20-win32-x64-node24"},"definitionRef":{"id":"helarc.phase26.metric.retry-count","revision":"v1"},"distribution":{"kind":"numeric_distribution","sampleCount":20,"minimum":0,"maximum":1,"mean":0.1,"variance":0.09473684210526317,"varianceMethod":"sample","p50":0,"p90":0.10000000000000142,"p95":1},"uncertainty":{"status":"available","method":"standard_error","confidence":0.95,"lower":-0.03489397287069085,"upper":0.23489397287069086},"values":{"pair.controlled-file-write.rep-1":0,"pair.controlled-file-write.rep-2":0,"pair.denied-command.rep-1":0,"pair.denied-command.rep-2":0,"pair.failed-check-recovery.rep-1":0,"pair.failed-check-recovery.rep-2":0,"pair.inspect-and-complete.rep-1":0,"pair.inspect-and-complete.rep-2":0,"pair.malformed-output-retry.rep-1":1,"pair.malformed-output-retry.rep-2":1,"pair.multi-file-mutation.rep-1":0,"pair.multi-file-mutation.rep-2":0,"pair.ordinary-shell-verification.rep-1":0,"pair.ordinary-shell-verification.rep-2":0,"pair.premature-completion.rep-1":0,"pair.premature-completion.rep-2":0,"pair.search.rep-1":0,"pair.search.rep-2":0,"pair.stale-evidence.rep-1":0,"pair.stale-evidence.rep-2":0}},
] as const;
const measuredCases = [
  {"id":"helarc.phase26.case.controlled-file-write","ordinal":1,"digest":"b3805be62e287ea11d9fa8e5271b10c99cbb3965520636855ce7ec9c699203c5","status":"succeeded"},
  {"id":"helarc.phase26.case.controlled-file-write","ordinal":2,"digest":"b10e254b4d1848e7ee1df9a953370e480211c91259d90a127f9491e205ab165b","status":"succeeded"},
  {"id":"helarc.phase26.case.denied-command","ordinal":1,"digest":"fbd28c525d6d6d623de67556aff08a5541812d99f5652c8a5cdd5796c6ba62de","status":"stopped"},
  {"id":"helarc.phase26.case.denied-command","ordinal":2,"digest":"9c13596f0e510977908d7ee68bbe1d8d2b159777cfbde06f277b312b60eaf3db","status":"stopped"},
  {"id":"helarc.phase26.case.failed-check-recovery","ordinal":1,"digest":"fba5b2523c491f7fac4d2f39cf28fffcbebe34ffe5e12b70170043e19af7b343","status":"succeeded"},
  {"id":"helarc.phase26.case.failed-check-recovery","ordinal":2,"digest":"ac86b6bb9d6466a9729c162be93fecd8b1bcd2d45c640a90b51054f4cdb40847","status":"succeeded"},
  {"id":"helarc.phase26.case.inspect-and-complete","ordinal":1,"digest":"e01ea7cb4c30aaf18314bfffc04fd4c0a51ce29e85b8900b96e35450555ca973","status":"succeeded"},
  {"id":"helarc.phase26.case.inspect-and-complete","ordinal":2,"digest":"42f0f017b26551e9c2e6e86917b22804ec2ea6e0da34f8f42355b6df44b6b12d","status":"succeeded"},
  {"id":"helarc.phase26.case.malformed-output-retry","ordinal":1,"digest":"bdb91ae86242e41572545a392758fca4dcbdcb15fddd402994996f9308af39b8","status":"succeeded"},
  {"id":"helarc.phase26.case.malformed-output-retry","ordinal":2,"digest":"9f6df91d8a28a81890712548705c83d926c87e03f01de4521c4b695cbd195984","status":"succeeded"},
  {"id":"helarc.phase26.case.multi-file-mutation","ordinal":1,"digest":"cd1141e9cc17bb07f7f191257163ad9d74816eda0574ce5a55e8f95971a30ade","status":"succeeded"},
  {"id":"helarc.phase26.case.multi-file-mutation","ordinal":2,"digest":"fb061efd69df2476723386ff0c5ead67d266226532f1996e6daad4c2908be115","status":"succeeded"},
  {"id":"helarc.phase26.case.ordinary-shell-verification","ordinal":1,"digest":"48727146e422390a928c2f2bcace3d86fb8dc4340f84a2f0f248696c950b5a73","status":"succeeded"},
  {"id":"helarc.phase26.case.ordinary-shell-verification","ordinal":2,"digest":"5514b7a813dd36252aa98d7a668d24e1402b68f3b8b0de2d7c985b2f1906d851","status":"succeeded"},
  {"id":"helarc.phase26.case.premature-completion","ordinal":1,"digest":"0e515fe2e18827a14d0cbfa56e4b8a977e19be8996e76f9ef92adb757e597bb5","status":"cancelled"},
  {"id":"helarc.phase26.case.premature-completion","ordinal":2,"digest":"21509e87d21b54a2b7e41eb65b925e6bbd9c8bf79ef81c5e9f104d15c278c760","status":"cancelled"},
  {"id":"helarc.phase26.case.search","ordinal":1,"digest":"ce424f273fff97174ff81dd2c524c98b68a108edb00de64cf52e8a427df239f8","status":"succeeded"},
  {"id":"helarc.phase26.case.search","ordinal":2,"digest":"fa1119f8bbb4bfe695686a32b06725db579e687ed3c8b47d000fad705f3e1f9f","status":"succeeded"},
  {"id":"helarc.phase26.case.stale-evidence","ordinal":1,"digest":"2afbd32bb71b300326a4be78dd1e567db879d27feeff8dac5e56e1a9e6ae25c1","status":"cancelled"},
  {"id":"helarc.phase26.case.stale-evidence","ordinal":2,"digest":"ca1a9b840d5a990e5afb9d80b559237aa74f9c5ba611f7a64895ffed6ea4bf24","status":"cancelled"},
] as const;

const metrics = predecessor.metrics.map((metric) => {
  const measured = measuredMetrics.find((candidate) => candidate.definitionRef.id === metric.definitionRef.id);
  if (measured === undefined) throw new TypeError("Normal-stop Metric identity is not recorded.");
  return {
    ...metric,
    ref: measured.ref,
    distribution: measured.distribution,
    uncertainty: measured.uncertainty,
    samples: metric.samples.map((sample) => {
      const values: Readonly<Record<string, boolean | number>> = measured.values;
      if (!Object.hasOwn(values, sample.pairingKey)) throw new TypeError("Normal-stop paired sample is not recorded.");
      return { ...sample, value: values[sample.pairingKey]! };
    }),
    targetSnapshotRef: target,
  };
});

function metricRef(ref: { readonly id: string }) {
  const metric = metrics.find((candidate) =>
    candidate.ref.id === ref.id.replace(".descendant-suspension-progression-baseline-result", ".normal-stop-settlement-baseline-result"));
  if (metric === undefined) throw new TypeError("Normal-stop Metric reference is not recorded.");
  return metric.ref;
}

export const HELARC_NORMAL_STOP_SETTLEMENT_ACCEPTED_BASELINE = deepFreeze({
  ...predecessor,
  corpusRevision: "helarc-normal-stop-settlement-corpus-v1",
  targetSnapshotRef: target,
  targetManifestDigest: "d6e741617f971cfd2039f0d47a6cb2bfb5cb9089a1abf1c819e3c844dad4fc23",
  reportRef: report,
  acceptanceRef: acceptance,
  publication: {
    ...predecessor.publication,
    reportRef: report,
    targetSnapshotRefs: [target],
    metricSummaries: predecessor.publication.metricSummaries.map((summary) => {
      const ref = metricRef(summary.metricRef);
      const metric = metrics.find((candidate) => candidate.ref.id === ref.id)!;
      return { ...summary, metricRef: ref, distribution: metric.distribution, uncertainty: metric.uncertainty };
    }),
    dimensionSummaries: predecessor.publication.dimensionSummaries.map((summary) => ({
      ...summary, metricRefs: summary.metricRefs.map(metricRef),
    })),
    gateOutcomes: predecessor.publication.gateOutcomes.map((gate) => ({ ...gate, metricRef: metricRef(gate.metricRef) })),
  },
  metrics,
  cases: predecessor.cases.map((item) => {
    const measured = measuredCases.find((candidate) => candidate.id === item.caseRef.id && candidate.ordinal === item.repetitionOrdinal);
    if (measured === undefined) throw new TypeError("Normal-stop Case identity is not recorded.");
    return { ...item, semanticDigest: measured.digest, targetOutcomeStatus: measured.status };
  }),
} satisfies HelarcEvaluationBaselineSignature);

export const HELARC_NORMAL_STOP_SETTLEMENT_BASELINE_ACCEPTANCE = deepFreeze({
  schemaVersion: 1,
  kind: "helarc_normal_stop_settlement_baseline_successor_acceptance",
  acceptedAt: "2026-09-05T00:00:00.000Z",
  predecessorAcceptanceRef: predecessor.acceptanceRef,
  successorAcceptanceRef: acceptance,
  predecessorReportRef: predecessor.reportRef,
  successorReportRef: report,
  comparison: "intentionally_incomparable_exact_target",
  changedTargetInputs: [
    "product.revision", "source.revision", "run-lifecycle.revision",
    "run-settlement.revision", "task-fulfillment-hook.revision",
    "target-adapter.revision", "fixture-manifest.revision", "expected-claims.revision",
  ],
  outcomeQuality: "passed",
  safety: "passed",
  reliability: "deterministic_candidate_repeated_equivalently",
  trajectory: "A denied command followed by an accepted Stop terminates normally without executing the denied effect or requiring test-driver cancellation.",
  limitations: "deterministic_system_cases_only_not_real_model_effectiveness",
});

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

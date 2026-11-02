import {mkdtemp, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createEvaluationTrial} from "@agent-anything/evaluation/trial";
import {createHelarcEvaluationCorpus, HELARC_EVALUATION_TIME} from "../dist/evaluation-targets/helarc/HelarcEvaluationCorpus.js";
import {createHelarcEvaluationTargetAdapter} from "../dist/evaluation-targets/helarc/HelarcEvaluationTarget.js";

const corpus = createHelarcEvaluationCorpus();
const source = corpus.cases.find(value => value.scenario === "ordinary_shell_verification");
const directory = await mkdtemp(join(tmpdir(), "helarc-command-baseline-"));
console.log(directory);
let first;
for (let repetition = 0; repetition < 8; repetition++) {
  const adapter = createHelarcEvaluationTargetAdapter({...corpus, cases: [source]});
  const trial = createEvaluationTrial({ref: {id: "ordinary-command-inspection", revision: "1"},
    campaignRef: corpus.campaign.ref, targetSnapshotRef: corpus.targetSnapshot.ref, caseRef: source.definition.ref,
    repetitionOrdinal: 1, seed: "fixed", pairingKey: source.definition.pairingKey,
    environmentProtocolRef: corpus.campaign.environmentProtocolRef, createdAt: HELARC_EVALUATION_TIME, metadata: {}});
  const signal = AbortSignal.timeout(60000);
  const preparation = await adapter.environment.prepare({trial, signal, deadlineAt: null});
  if (preparation.status !== "prepared") throw new Error("Environment unavailable");
  try {
    const invocation = await adapter.target.invoke({trial, leaseRef: preparation.lease.ref, signal, deadlineAt: null});
    if (invocation.status !== "observed") throw new Error("Target observation unavailable");
    const result = await adapter.capture.capture({captureRef: {id: "capture", revision: "1"}, trialRef: trial.ref,
      targetSnapshotRef: trial.targetSnapshotRef, caseRef: trial.caseRef, policyRef: corpus.capturePolicy.ref,
      environmentRef: preparation.lease.ref, targetObservationRef: invocation.observation.ref, signal, deadlineAt: null});
    const evidence = {outcome: invocation.observation.outcome, slots: result.capture.slots};
    await writeFile(join(directory, `${repetition}.json`), JSON.stringify(evidence, null, 2));
    first ??= evidence;
    const changes = difference(first, evidence);
    console.log(JSON.stringify({repetition, changes}));
  } finally {await adapter.environment.cleanup({trial, lease: preparation.lease, signal: new AbortController().signal});}
}
function difference(a, b, path = "") {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return [{path, before: a, after: b}];
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap(key => difference(a[key], b[key], `${path}/${key}`));
}

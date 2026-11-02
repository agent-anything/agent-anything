import assert from "node:assert/strict";
import {writeFile} from "node:fs/promises";
import {runHelarcEvaluationBaselineCandidate,projectHelarcEvaluationBaselineSignature,compareHelarcEvaluationBaseline} from "../dist/evaluation-targets/helarc/index.js";

const first=await runHelarcEvaluationBaselineCandidate(),second=await runHelarcEvaluationBaselineCandidate();
const signature=projectHelarcEvaluationBaselineSignature(first);
assert.equal(compareHelarcEvaluationBaseline(signature,second).status,"equivalent");
assert.deepEqual(first.publication.gateOutcomes.map(g=>g.status),["passed","passed"]);
assert(first.cases.every(c=>c.traceIssueCodes.length===0));
const content=`import type { HelarcEvaluationBaselineSignature } from "../HelarcEvaluationExecution.js";\n\n// Generated after two independently executed, equivalent scripted campaigns.\nexport const HELARC_EXPLICIT_TASK_EXECUTION_ACCEPTED_BASELINE = deepFreeze(${JSON.stringify(signature,null,2)} satisfies HelarcEvaluationBaselineSignature);\n\nfunction deepFreeze<T>(value:T):T {\n  if(value!==null&&typeof value==="object") {for(const child of Object.values(value))deepFreeze(child);Object.freeze(value);}\n  return value;\n}\n`;
await writeFile(new URL("../src/evaluation-targets/helarc/baseline/HelarcExplicitTaskExecutionBaseline.ts",import.meta.url),content);
console.log(JSON.stringify({status:"accepted",target:signature.targetSnapshotRef,manifest:signature.targetManifestDigest,cases:first.cases.length,scope:"scripted integration, not live-model effectiveness or elapsed performance"}));

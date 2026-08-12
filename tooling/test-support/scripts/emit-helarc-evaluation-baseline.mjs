import {
  projectHelarcEvaluationBaselineSignature,
  runHelarcEvaluationBaselineCandidate,
} from "../dist/evaluation-targets/helarc/index.js";

const candidate = await runHelarcEvaluationBaselineCandidate();
const signature = projectHelarcEvaluationBaselineSignature(candidate);

process.stdout.write(`${JSON.stringify(signature, null, 2)}\n`);

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  compareHelarcProductEffectiveness,
  createHelarcProductEffectivenessDefinition,
  importHelarcProductEffectivenessEvidenceBundle,
} from "../dist/evaluation-targets/helarc/index.js";

const options = parseArguments(process.argv.slice(2));
const definition = createHelarcProductEffectivenessDefinition();
const [codexJson, helarcJson] = await Promise.all([
  readFile(resolve(options.codex), "utf8"),
  readFile(resolve(options.helarc), "utf8"),
]);
const codex = importHelarcProductEffectivenessEvidenceBundle({
  json: codexJson,
  objective: definition.objective,
  suite: definition.suite,
});
const helarc = importHelarcProductEffectivenessEvidenceBundle({
  json: helarcJson,
  objective: definition.objective,
  suite: definition.suite,
});
const comparison = compareHelarcProductEffectiveness({
  suite: definition.suite,
  codex,
  helarc,
  reportRef: { id: "helarc.product-effectiveness.report", revision: "candidate-v1" },
  campaignRef: definition.refs.campaign,
  createdAt: new Date().toISOString(),
});
if (options.output !== null) {
  await writeFile(resolve(options.output), `${JSON.stringify(comparison, null, 2)}\n`, "utf8");
}
process.stdout.write(`${JSON.stringify({
  releaseStatus: comparison.releaseStatus,
  releaseReason: comparison.releaseReason,
  requiredPairCount: comparison.requiredPairCount,
  comparablePairCount: comparison.comparablePairCount,
  codexWeightedOutcome: comparison.codex?.value ?? null,
  helarcWeightedOutcome: comparison.helarc?.value ?? null,
  outcomeRatio: comparison.outcomeRatio,
  outcomeRatioInterval: comparison.outcomeRatioInterval,
  safety: comparison.safety,
  diagnostics: comparison.diagnostics,
  output: options.output === null ? null : resolve(options.output),
}, null, 2)}\n`);
process.exitCode = comparison.releaseStatus === "passed"
  ? 0
  : comparison.releaseStatus === "failed" ? 1 : 2;

function parseArguments(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!["--codex", "--helarc", "--output"].includes(key) || typeof value !== "string") {
      throw new TypeError("Usage: evaluation:product-effectiveness:compare -- --codex <json> --helarc <json> [--output <json>]");
    }
    values.set(key, value);
  }
  if (!values.has("--codex") || !values.has("--helarc")) {
    throw new TypeError("Both --codex and --helarc Evidence bundle paths are required.");
  }
  return {
    codex: values.get("--codex"),
    helarc: values.get("--helarc"),
    output: values.get("--output") ?? null,
  };
}

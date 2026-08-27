import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  verifyHelarcAgentInstructionCampaignArtifact,
} from "../tooling/test-support/dist/evaluation-targets/helarc/index.js";

const options = parseArguments(process.argv.slice(2));
const inputPath = resolve(options.input);
const artifact = verifyHelarcAgentInstructionCampaignArtifact(
  JSON.parse(await readFile(inputPath, "utf8")),
);

process.stdout.write(`${JSON.stringify({
  disposition: artifact.disposition,
  digest: artifact.digest,
  input: inputPath,
}, null, 2)}\n`);

function parseArguments(args) {
  if (args.length !== 2 || args[0] !== "--input" || args[1].trim().length === 0) {
    throw new TypeError(
      "Usage: evaluation:agent-instructions:verify -- --input <evidence.json>",
    );
  }
  return { input: args[1] };
}

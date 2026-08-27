import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  OpenAICompatibleProvider,
} from "../harness/integrations/providers/dist/openai-compatible/index.js";
import {
  OllamaProvider,
} from "../harness/integrations/providers/dist/ollama/index.js";
import {
  captureHelarcProductEffectiveness,
  createHelarcProductEffectivenessDefinition,
  createHelarcProductEffectivenessTargetSnapshot,
  createHelarcProductEffectivenessTargetValues,
} from "../tooling/test-support/dist/evaluation-targets/helarc/index.js";

const options = parseArguments(process.argv.slice(2));
const providerKind = requiredEnvironment("HELARC_EVALUATION_PROVIDER");
const model = requiredEnvironment("HELARC_EVALUATION_MODEL");
const baseUrl = safeProviderBaseUrl(requiredEnvironment("HELARC_EVALUATION_BASE_URL"));
const productVersion = requiredEnvironment("HELARC_EVALUATION_PRODUCT_VERSION");
const sourceRevision = requiredEnvironment("HELARC_EVALUATION_SOURCE_REVISION");
const sourceDirtyState = sourceDirtyStateEnvironment();
const sourceTreeDigest = requiredEnvironment("HELARC_EVALUATION_SOURCE_TREE_DIGEST");
const providerRevision = requiredEnvironment("HELARC_EVALUATION_PROVIDER_REVISION");
const modelRevision = requiredEnvironment("HELARC_EVALUATION_MODEL_REVISION");
const instructionTarget = instructionTargetEnvironment();
const environment = requiredEnvironment("HELARC_EVALUATION_ENVIRONMENT");
const timeoutMs = positiveInteger(
  process.env.HELARC_EVALUATION_TIMEOUT_MS ?? "120000",
  "HELARC_EVALUATION_TIMEOUT_MS",
);
const maximumInputBytes = positiveInteger(
  process.env.HELARC_EVALUATION_MAXIMUM_INPUT_BYTES ?? "1048576",
  "HELARC_EVALUATION_MAXIMUM_INPUT_BYTES",
);
const definition = createHelarcProductEffectivenessDefinition();
const createdAt = new Date().toISOString();
const targetSnapshot = createHelarcProductEffectivenessTargetSnapshot({
  ref: {
    id: `helarc.product-effectiveness.target.helarc.${instructionTarget}`,
    revision: productVersion,
  },
  targetRef: { id: "helarc.product", revision: productVersion },
  objective: definition.objective,
  targetName: "helarc",
  sourceRevision,
  values: createHelarcProductEffectivenessTargetValues({
    instructionTarget,
    sourceRevision,
    sourceDirtyState,
    sourceTreeDigest,
    packageRevisions: packageRevisions(sourceRevision, sourceTreeDigest),
    productVersion,
    providerId: providerKind,
    providerKind,
    providerRevision,
    providerEndpoint: baseUrl,
    providerAuthentication: providerKind === "openai-compatible" &&
        (process.env.HELARC_EVALUATION_API_KEY ?? "").length > 0
      ? "bearer"
      : "none",
    modelId: model,
    modelRevision,
    environmentId: environment,
    providerTimeoutMs: timeoutMs,
    maximumInputBytes,
    sandboxEnforcement: "disabled",
    limitations: [
      "Local Sandbox enforcement is disabled in the current Evaluation target.",
      "The comparison applies only to the exact fixed Product-effectiveness Suite.",
    ],
  }),
  disposition: { status: "comparable" },
  createdAt,
});
const providerFactory = () => createProvider({
  providerKind,
  model,
  baseUrl,
  timeoutMs,
  maximumInputBytes,
});
const bundle = await captureHelarcProductEffectiveness({
  objective: definition.objective,
  suite: definition.suite,
  targetSnapshot,
  instructionTarget,
  providerFactory,
  productVersion,
  model,
  environment,
  createdAt,
});
const outputPath = resolve(options.output);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({
  status: bundle.trials.every((trial) => trial.status === "completed")
    ? "captured"
    : "incomplete",
  output: outputPath,
  bundleDigest: bundle.bundleDigest,
  completedTrials: bundle.trials.filter((trial) => trial.status === "completed").length,
  requiredTrials: bundle.trials.length,
}, null, 2)}\n`);

function createProvider(input) {
  if (input.providerKind === "ollama") {
    return new OllamaProvider({
      baseUrl: input.baseUrl,
      model: input.model,
      timeoutMs: input.timeoutMs,
      nativeToolInteraction: { supported: false },
      inputLimit: {
        maximumBytes: input.maximumInputBytes,
        source: "host_configured",
      },
    });
  }
  if (input.providerKind === "openai-compatible") {
    return new OpenAICompatibleProvider({
      baseUrl: input.baseUrl,
      apiKey: process.env.HELARC_EVALUATION_API_KEY ?? "",
      model: input.model,
      timeoutMs: input.timeoutMs,
      nativeToolInteraction: { supported: false },
      inputLimit: {
        maximumBytes: input.maximumInputBytes,
        source: "host_configured",
      },
    });
  }
  throw new TypeError("HELARC_EVALUATION_PROVIDER must be 'ollama' or 'openai-compatible'.");
}

function parseArguments(args) {
  if (args.length !== 2 || args[0] !== "--output" || args[1].trim().length === 0) {
    throw new TypeError("Usage: evaluation:product-effectiveness:capture -- --output <evidence.json>");
  }
  return { output: args[1] };
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} is required.`);
  }
  return value.trim();
}

function instructionTargetEnvironment() {
  const value = requiredEnvironment("HELARC_EVALUATION_INSTRUCTION_TARGET");
  if (value !== "minimal" && value !== "production") {
    throw new TypeError(
      "HELARC_EVALUATION_INSTRUCTION_TARGET must be 'minimal' or 'production'.",
    );
  }
  return value;
}

function sourceDirtyStateEnvironment() {
  const value = requiredEnvironment("HELARC_EVALUATION_SOURCE_DIRTY_STATE");
  if (value !== "clean" && value !== "included") {
    throw new TypeError(
      "HELARC_EVALUATION_SOURCE_DIRTY_STATE must be 'clean' or 'included'.",
    );
  }
  return value;
}

function packageRevisions(sourceRevision, sourceTreeDigest) {
  const revision = `${sourceRevision}:${sourceTreeDigest}`;
  return Object.freeze(Object.fromEntries([
    "@agent-anything/action-execution",
    "@agent-anything/agent-runtime",
    "@agent-anything/evaluation",
    "@agent-anything/helarc",
    "@agent-anything/helarc-local-environment",
    "@agent-anything/model-interaction",
    "@agent-anything/test-support",
    "@agent-anything/tools",
    "@agent-anything/verification",
  ].map((name) => [name, revision])));
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return parsed;
}

function safeProviderBaseUrl(value) {
  const url = new URL(value);
  if ((url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username.length > 0 || url.password.length > 0 ||
      url.search.length > 0 || url.hash.length > 0) {
    throw new TypeError(
      "HELARC_EVALUATION_BASE_URL must be an HTTP(S) URL without credentials, query, or fragment.",
    );
  }
  return url.toString().replace(/\/$/, "");
}

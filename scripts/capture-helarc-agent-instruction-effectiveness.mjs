import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  OpenAICompatibleProvider,
} from "../harness/integrations/providers/dist/openai-compatible/index.js";
import {
  OllamaProvider,
} from "../harness/integrations/providers/dist/ollama/index.js";
import {
  captureHelarcProductEffectiveness,
  compareHelarcAgentInstructionEffectiveness,
  createHelarcProductEffectivenessDefinition,
  createHelarcProductEffectivenessTargetSnapshot,
  createHelarcProductEffectivenessTargetValues,
} from "../tooling/test-support/dist/evaluation-targets/helarc/index.js";

const options = parseArguments(process.argv.slice(2));
const requiredNames = [
  "HELARC_EVALUATION_PROVIDER",
  "HELARC_EVALUATION_MODEL",
  "HELARC_EVALUATION_BASE_URL",
  "HELARC_EVALUATION_PRODUCT_VERSION",
  "HELARC_EVALUATION_ENVIRONMENT",
];
const missing = requiredNames.filter((name) => readEnvironment(name) === null);
if (missing.length > 0) {
  await emit(options.output, {
    schemaVersion: 1,
    kind: "helarc_agent_instruction_effectiveness_capture",
    disposition: {
      status: "unavailable",
      code: "evaluation_configuration_unavailable",
      reason: "Real-Provider instruction Evaluation configuration is incomplete.",
    },
    missingConfiguration: missing,
    createdAt: new Date().toISOString(),
  });
  process.exitCode = 0;
} else {
  await captureConfigured(options.output);
}

async function captureConfigured(output) {
  const providerKind = requiredEnvironment("HELARC_EVALUATION_PROVIDER");
  const model = requiredEnvironment("HELARC_EVALUATION_MODEL");
  const baseUrl = safeProviderBaseUrl(requiredEnvironment("HELARC_EVALUATION_BASE_URL"));
  const productVersion = requiredEnvironment("HELARC_EVALUATION_PRODUCT_VERSION");
  const environment = requiredEnvironment("HELARC_EVALUATION_ENVIRONMENT");
  const timeoutMs = positiveInteger(
    process.env.HELARC_EVALUATION_TIMEOUT_MS ?? "120000",
    "HELARC_EVALUATION_TIMEOUT_MS",
  );
  const maximumInputBytes = positiveInteger(
    process.env.HELARC_EVALUATION_MAXIMUM_INPUT_BYTES ?? "1048576",
    "HELARC_EVALUATION_MAXIMUM_INPUT_BYTES",
  );
  const createdAt = new Date().toISOString();
  const definition = createHelarcProductEffectivenessDefinition();
  const capture = async (instructionTarget) => {
    const targetSnapshot = createHelarcProductEffectivenessTargetSnapshot({
      ref: {
        id: `helarc.agent-instruction-effectiveness.target.${instructionTarget}`,
        revision: productVersion,
      },
      targetRef: { id: "helarc.product", revision: productVersion },
      objective: definition.objective,
      targetName: "helarc",
      sourceRevision: productVersion,
      values: createHelarcProductEffectivenessTargetValues({
        instructionTarget,
        productVersion,
        providerId: providerKind,
        providerKind,
        providerRevision: productVersion,
        providerEndpoint: baseUrl,
        providerAuthentication: providerKind === "openai-compatible" &&
            (process.env.HELARC_EVALUATION_API_KEY ?? "").length > 0
          ? "bearer"
          : "none",
        modelId: model,
        modelRevision: productVersion,
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
    return await captureHelarcProductEffectiveness({
      objective: definition.objective,
      suite: definition.suite,
      targetSnapshot,
      instructionTarget,
      providerFactory: () => createProvider({
        providerKind,
        model,
        baseUrl,
        timeoutMs,
        maximumInputBytes,
      }),
      productVersion,
      model,
      environment,
      createdAt,
    });
  };
  const minimal = await capture("minimal");
  const production = await capture("production");
  const comparison = compareHelarcAgentInstructionEffectiveness({ minimal, production });
  await emit(output, {
    schemaVersion: 1,
    kind: "helarc_agent_instruction_effectiveness_capture",
    disposition: comparison.disposition,
    comparison,
    evidence: { minimal, production },
    createdAt,
  });
}

function createProvider(input) {
  if (input.providerKind === "ollama") {
    return new OllamaProvider({
      baseUrl: input.baseUrl,
      model: input.model,
      timeoutMs: input.timeoutMs,
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
      inputLimit: {
        maximumBytes: input.maximumInputBytes,
        source: "host_configured",
      },
    });
  }
  throw new TypeError("HELARC_EVALUATION_PROVIDER must be 'ollama' or 'openai-compatible'.");
}

async function emit(output, artifact) {
  const outputPath = resolve(output);
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    disposition: artifact.disposition,
    output: outputPath,
  }, null, 2)}\n`);
}

function parseArguments(args) {
  if (args.length !== 2 || args[0] !== "--output" || args[1].trim().length === 0) {
    throw new TypeError(
      "Usage: evaluation:agent-instructions:capture -- --output <evidence.json>",
    );
  }
  return { output: args[1] };
}

function readEnvironment(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function requiredEnvironment(name) {
  const value = readEnvironment(name);
  if (value === null) throw new TypeError(`${name} is required.`);
  return value;
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
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new TypeError(
      "HELARC_EVALUATION_BASE_URL must be an HTTP(S) URL without credentials, query, or fragment.",
    );
  }
  return url.toString().replace(/\/$/, "");
}

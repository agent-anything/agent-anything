import { createHash } from "node:crypto";
import {
  OpenAICompatibleProvider,
} from "../harness/integrations/providers/dist/openai-compatible/index.js";
import {
  OllamaProvider,
} from "../harness/integrations/providers/dist/ollama/index.js";
import {
  createEvaluationTrial,
} from "../harness/evaluation/dist/trial/index.js";
import {
  createHelarcEvaluationCorpus,
  executeHelarcEvaluationCase,
} from "../tooling/test-support/dist/evaluation-targets/helarc/index.js";

const requiredNames = [
  "HELARC_EVALUATION_PROVIDER",
  "HELARC_EVALUATION_MODEL",
  "HELARC_EVALUATION_BASE_URL",
];
const missing = requiredNames.filter((name) => (process.env[name] ?? "").trim().length === 0);
if (missing.length > 0) {
  emit({
    status: "unavailable",
    reasonCode: "configuration_unavailable",
    missing,
    gating: false,
  });
  process.exit(0);
}

const providerKind = process.env.HELARC_EVALUATION_PROVIDER.trim();
const model = process.env.HELARC_EVALUATION_MODEL.trim();
const baseUrl = safeProviderBaseUrl(process.env.HELARC_EVALUATION_BASE_URL.trim());
const timeoutMs = positiveInteger(
  process.env.HELARC_EVALUATION_TIMEOUT_MS ?? "120000",
  "HELARC_EVALUATION_TIMEOUT_MS",
);
const maximumInputBytes = positiveInteger(
  process.env.HELARC_EVALUATION_MAXIMUM_INPUT_BYTES ?? "1048576",
  "HELARC_EVALUATION_MAXIMUM_INPUT_BYTES",
);
const corpus = createHelarcEvaluationCorpus();
const caseDefinition = corpus.cases.find(({ scenario }) => scenario === "inspect_and_complete");
if (caseDefinition === undefined) throw new TypeError("Stop Review diagnostic Case is unavailable.");

const trials = [];
for (let repetitionOrdinal = 1; repetitionOrdinal <= 3; repetitionOrdinal += 1) {
  try {
    const material = await executeHelarcEvaluationCase({
      trial: createEvaluationTrial({
        ref: {
          id: `helarc.run-stop-review-diagnostic.trial.${repetitionOrdinal}`,
          revision: "v1",
        },
        campaignRef: { id: "helarc.run-stop-review-diagnostic.campaign", revision: "v1" },
        targetSnapshotRef: corpus.targetSnapshot.ref,
        caseRef: caseDefinition.definition.ref,
        repetitionOrdinal,
        seed: `helarc-run-stop-review-diagnostic-${repetitionOrdinal}`,
        pairingKey: `run-stop-review-diagnostic.rep-${repetitionOrdinal}`,
        environmentProtocolRef: {
          id: "helarc.run-stop-review-diagnostic.environment-protocol",
          revision: "v1",
        },
        createdAt: new Date().toISOString(),
        metadata: { diagnostic: "run_stop_review" },
      }),
      caseDefinition,
      provider: createProvider({
        providerKind,
        model,
        baseUrl,
        timeoutMs,
        maximumInputBytes,
      }),
      signal: new AbortController().signal,
      now: () => new Date().toISOString(),
      maxDurationMs: timeoutMs,
      maxIterations: 50,
      maxActions: 100,
    });
    trials.push(projectTrial(material, repetitionOrdinal));
  } catch (error) {
    trials.push({
      repetitionOrdinal,
      status: "unavailable",
      reasonCode: "provider_or_target_unavailable",
      errorClass: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

const completed = trials.filter(({ status }) => status === "completed");
const signatures = new Set(completed.map(({ trajectoryDigest }) => trajectoryDigest));
emit({
  status: completed.length === 0 ? "unavailable" : "observed",
  gating: false,
  provider: providerKind,
  model,
  repetitions: trials.length,
  completedRepetitions: completed.length,
  repeatedTrajectory: completed.length === trials.length && signatures.size === 1,
  stopReviewVisible: completed.some(({ stopReviewCount }) => stopReviewCount > 0),
  feedbackThenAllowedStop: completed.some(({ feedbackThenAllowedStop }) => feedbackThenAllowedStop),
  trials,
  limitations: [
    "This diagnostic is observational and cannot replace deterministic Stop Review conformance.",
    "One fixed Case and three stochastic executions do not establish general Product effectiveness.",
  ],
});

function projectTrial(material, repetitionOrdinal) {
  if (!material.providerResults.some(({ kind }) => kind === "succeeded")) {
    return {
      repetitionOrdinal,
      status: "unavailable",
      reasonCode: "provider_execution_unavailable",
      runStatus: material.runResult.status,
      runCode: material.runResult.code,
    };
  }
  const reviews = material.runResult.items.flatMap(({ payload }) =>
    payload.kind === "stop_review" ? [payload.review] : []);
  const feedback = material.runResult.items.flatMap(({ payload }) =>
    payload.kind === "stop_feedback" ? [payload.feedback] : []);
  const feedbackThenAllowedStop = feedback.length > 0 &&
    reviews.some(({ decision }) => decision === "allow_stop");
  const trajectory = {
    runStatus: material.runResult.status,
    runCode: material.runResult.code,
    actionNames: material.actionNames,
    reviews: reviews.map((review) => ({
      decision: review.decision,
      requiredFeedbackRounds: review.requiredFeedbackRounds,
      advisoryFeedbackRounds: review.advisoryFeedbackRounds,
      checkCodes: review.checks.map(({ code }) => code),
      limitationCodes: review.limitations.map(({ code }) => code),
    })),
    feedback: feedback.map((item) => ({
      owner: item.owner,
      severity: item.severity,
      round: item.round,
      code: item.code,
    })),
  };
  return {
    repetitionOrdinal,
    status: "completed",
    runStatus: material.runResult.status,
    runCode: material.runResult.code,
    controllerTurns: material.runResult.counters.controllerTurns,
    actionCount: material.runResult.counters.runActions,
    stopReviewCount: reviews.length,
    stopFeedbackCount: feedback.length,
    requiredFeedbackRounds: Math.max(0, ...reviews.map((review) => review.requiredFeedbackRounds)),
    advisoryFeedbackRounds: Math.max(0, ...reviews.map((review) => review.advisoryFeedbackRounds)),
    feedbackThenAllowedStop,
    trajectoryDigest: digest(trajectory),
  };
}

function createProvider(input) {
  if (input.providerKind === "ollama") {
    return new OllamaProvider({
      baseUrl: input.baseUrl,
      model: input.model,
      timeoutMs: input.timeoutMs,
      nativeToolInteraction: { supported: true },
      inputLimit: { maximumBytes: input.maximumInputBytes, source: "host_configured" },
    });
  }
  if (input.providerKind === "openai-compatible") {
    return new OpenAICompatibleProvider({
      baseUrl: input.baseUrl,
      apiKey: process.env.HELARC_EVALUATION_API_KEY ?? "",
      model: input.model,
      timeoutMs: input.timeoutMs,
      nativeToolInteraction: { supported: true },
      inputLimit: { maximumBytes: input.maximumInputBytes, source: "host_configured" },
    });
  }
  throw new TypeError("HELARC_EVALUATION_PROVIDER must be 'ollama' or 'openai-compatible'.");
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

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return parsed;
}

function digest(value) {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

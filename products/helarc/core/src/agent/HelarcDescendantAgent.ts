import type { Agent } from "@agent-anything/agent-core/agent";
import type { RunnerDelegationComposition } from "@agent-anything/agent-runtime/runner";
import {
  createDelegationContextPlan,
  createDelegationContextMaterial,
  createDelegationLimits,
  createDelegationResultExpectation,
  type DelegationResult,
} from "@agent-anything/agent-runtime/delegation";
import type { OperationFailure } from "@agent-anything/operation-catalog/result";
import type { ToolRegistrationInput } from "@agent-anything/tools/registration";
import type { HelarcAgentOutput } from "../controller/HelarcController.js";
import { findHelarcBaselineToolContract } from "../tools/HelarcBaselineToolContracts.js";

export interface HelarcDescendantAgentContribution {
  readonly tool: ToolRegistrationInput;
  readonly delegation: RunnerDelegationComposition;
}

export function createHelarcDescendantAgentContribution(
  agent: Agent<HelarcAgentOutput>,
  admittedAt: string,
): HelarcDescendantAgentContribution {
  const contract = findHelarcBaselineToolContract("Agent");
  return Object.freeze({
    tool: Object.freeze({
      admissionId: "helarc.agent.v1",
      descriptor: Object.freeze({
        ref: Object.freeze({
          tool: Object.freeze({ namespace: "helarc", name: "agent" }),
          revision: "1",
        }),
        name: contract.name,
        description: contract.description,
        inputSchema: contract.inputSchema,
        outputSchema: contract.outputSchema,
        schemaRevisions: Object.freeze({
          dialect: "json-schema-2020-12",
          input: "1",
          output: "1",
          translation: "native-1",
        }),
        annotations: contract.annotations,
        source: Object.freeze({
          kind: "product" as const,
          sourceId: "helarc",
          sourceRevision: "1",
          activationEpoch: null,
        }),
        binding: Object.freeze({
          kind: "descendant_agent" as const,
          agent: Object.freeze({ id: agent.id, revision: agent.revision }),
          revision: "descendant-agent-binding-1",
        }),
        retirement: null,
        metadata: Object.freeze({ profile: "code-agent" }),
      }),
      allowedOrigins: Object.freeze(["model" as const]),
      admittedAt,
    }),
    delegation: Object.freeze({
      preparation: Object.freeze({
        assessAvailability(
          input: Parameters<RunnerDelegationComposition["preparation"]["assessAvailability"]>[0],
        ) {
          const admitted = input.targetAgent.id === agent.id &&
            input.targetAgent.revision === agent.revision;
          return Object.freeze({
            basisRefs: Object.freeze([Object.freeze({
              owner: "helarc",
              kind: "descendant_agent_admission",
              id: `${agent.id}@${agent.revision}`,
              revision: admitted ? "admitted" : "not_admitted",
            })]),
            disposition: admitted ? "available" as const : "unavailable" as const,
            reason: admitted ? null : "no_eligible_subject" as const,
          });
        },
        async prepare(
          input: Parameters<RunnerDelegationComposition["preparation"]["prepare"]>[0],
        ) {
          if (input.targetAgent.id !== agent.id || input.targetAgent.revision !== agent.revision) {
            throw new TypeError("The requested descendant Agent revision is not admitted.");
          }
          const delegated = snapshotDelegatedInput(input.toolCall.input);
          const rootPurpose = createDelegationContextMaterial({
            owner: "helarc",
            kind: "root_task_purpose",
            id: input.root.task.id,
            payload: Object.freeze({
              kind: "helarc_root_task_purpose",
              taskKind: input.root.task.kind,
              taskInput: input.root.task.input,
            }),
          });
          const limits = createDelegationLimits({
            maxControllerTurns: input.limitCeiling.maxControllerTurns,
            maxActions: input.limitCeiling.maxActions,
            maxDurationMs: input.limitCeiling.maxDurationMs,
            maxContextBytes: input.limitCeiling.maxContextBytes,
            maxResultBytes: input.limitCeiling.maxResultBytes,
          });
          return Object.freeze({
            agent,
            rootPurpose,
            preparation: Object.freeze({
              schemaVersion: 1 as const,
              childAgent: Object.freeze({ id: agent.id, revision: agent.revision }),
              task: Object.freeze({
                kind: "helarc.delegated-code-task",
                input: Object.freeze({ prompt: delegated.prompt }),
                metadata: Object.freeze({
                  product: "helarc",
                  description: delegated.description,
                }),
              }),
              objective: Object.freeze({
                text: delegated.prompt,
                constraints: Object.freeze([]),
              }),
              expectedResult: createDelegationResultExpectation({
                requirements: Object.freeze([
                  Object.freeze({ form: "narrative" as const, required: true, maxItems: 1 }),
                  Object.freeze({ form: "evidence" as const, required: false, maxItems: 64 }),
                  Object.freeze({ form: "artifacts" as const, required: false, maxItems: 64 }),
                  Object.freeze({ form: "validation" as const, required: false, maxItems: 1 }),
                  Object.freeze({ form: "effects" as const, required: false, maxItems: 64 }),
                ]),
                maxNarrativeCharacters: 16_000,
              }),
              contextPlan: createDelegationContextPlan({
                entries: Object.freeze([Object.freeze({
                  role: "root_purpose" as const,
                  material: rootPurpose.ref,
                  necessity: "mandatory" as const,
                })]),
                maxContextBytes: limits.maxContextBytes,
              }),
              requestedAuthority: Object.freeze(input.authorityCeiling.map((dimension) =>
                Object.freeze({
                  kind: dimension.kind,
                  allowed: Object.freeze([...dimension.allowed]),
                  required: Object.freeze([...dimension.required]),
                }))),
              limits,
              predecessor: delegated.predecessor,
            }),
          });
        },
      }),
      narrativeProjection: Object.freeze({
        project(
          input: Parameters<RunnerDelegationComposition["narrativeProjection"]["project"]>[0],
        ) {
          return isHelarcOutput(input.finalOutput) ? input.finalOutput.summary : null;
        },
      }),
      resultProjection: Object.freeze({
        project: projectDescendantResult,
      }),
    }),
  });
}

function snapshotDelegatedInput(candidate: unknown): {
  readonly prompt: string;
  readonly description: string | null;
  readonly predecessor: { readonly id: string; readonly revision: string } | null;
} {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError("Agent Tool input must be an object.");
  }
  const input = candidate as Record<string, unknown>;
  if (Object.keys(input).some((key) =>
    key !== "prompt" && key !== "description" && key !== "predecessor_result")) {
    throw new TypeError("Agent Tool input contains an unsupported field.");
  }
  const prompt = boundedText(input.prompt, 64_000, "prompt");
  const description = input.description === undefined
    ? null
    : boundedText(input.description, 1_024, "description");
  const predecessor = input.predecessor_result === undefined
    ? null
    : snapshotPredecessorResult(input.predecessor_result);
  return Object.freeze({ prompt, description, predecessor });
}

function projectDescendantResult(
  result: DelegationResult,
): import("@agent-anything/agent-runtime/runner").DescendantOperationOutcome {
  const artifacts = result.artifacts.refs;
  const output = Object.freeze({
    delegation_result_id: result.ref.id,
    delegation_result_revision: result.ref.revision,
    child_run_id: result.correlation.child.run.id,
    status: result.terminal.status,
    summary: result.narrative?.text ?? "",
    artifact_refs: artifacts,
    validation_status: result.validation.status,
    effect_status: result.effects.status,
    uncertainty: result.uncertainty,
    failure_code: result.terminal.code,
  });
  const requiredMissing = result.expectationCoverage.some(
    ({ required, disposition }) => required && disposition !== "present",
  );
  const uncertain = result.effects.status === "partial" ||
    result.effects.status === "unknown" ||
    result.limitDisposition.status === "exhausted";
  if (result.terminal.status === "succeeded" && !requiredMissing && !uncertain) {
    return Object.freeze({
      status: "succeeded" as const,
      output,
      failure: null,
    });
  }
  if (result.terminal.status === "succeeded" || result.terminal.status === "blocked") {
    return Object.freeze({
      status: "partial" as const,
      output,
      failure: descendantFailure(
        result.terminal.code ?? "delegation_result_incomplete",
        "Descendant result is incomplete, limited, or uncertain.",
      ),
    });
  }
  if (result.terminal.status === "cancelled") {
    return Object.freeze({
      status: "cancelled" as const,
      output: null,
      failure: descendantFailure(
        result.terminal.code ?? "runtime_cancelled",
        "Descendant Run was cancelled.",
      ),
    });
  }
  return Object.freeze({
    status: "failed" as const,
    output: null,
    failure: descendantFailure(
      result.terminal.code ?? "descendant_run_failed",
      "Descendant Run failed.",
    ),
  });
}

function snapshotPredecessorResult(candidate: unknown): {
  readonly id: string;
  readonly revision: string;
} {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError("predecessor_result must be an object.");
  }
  const value = candidate as Record<string, unknown>;
  if (Object.keys(value).some((key) => key !== "id" && key !== "revision")) {
    throw new TypeError("predecessor_result contains an unsupported field.");
  }
  return Object.freeze({
    id: boundedText(value.id, 1_024, "predecessor_result.id"),
    revision: boundedText(value.revision, 256, "predecessor_result.revision"),
  });
}

function descendantFailure(code: string, message: string): OperationFailure {
  return Object.freeze({
    owner: "helarc",
    code,
    message,
    retryable: false,
    metadata: Object.freeze({}),
  });
}

function isHelarcOutput(candidate: unknown): candidate is HelarcAgentOutput {
  return candidate !== null && typeof candidate === "object" &&
    (candidate as { kind?: unknown }).kind === "complete" &&
    typeof (candidate as { summary?: unknown }).summary === "string";
}

function boundedText(candidate: unknown, maxLength: number, field: string): string {
  if (typeof candidate !== "string" || candidate.length < 1 || candidate.length > maxLength || candidate !== candidate.trim()) {
    throw new TypeError(`Agent Tool ${field} must be bounded non-empty text.`);
  }
  return candidate;
}

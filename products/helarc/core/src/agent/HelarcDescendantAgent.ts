import type { RunInput } from "@agent-anything/agent-core/input";
import type { Agent } from "@agent-anything/agent-core/agent";
import type { DescendantRunCompositionPort } from "@agent-anything/agent-runtime/runner";
import type { RunResult } from "@agent-anything/agent-runtime/run";
import type { OperationFailure } from "@agent-anything/operation-catalog/result";
import type { ToolRegistrationInput } from "@agent-anything/tools/registration";
import type { HelarcAgentOutput } from "../controller/HelarcController.js";
import { findHelarcBaselineToolContract } from "../tools/HelarcBaselineToolContracts.js";
import { createHelarcAgent } from "./HelarcAgent.js";

export interface HelarcDescendantAgentContribution {
  readonly tool: ToolRegistrationInput;
  readonly composition: DescendantRunCompositionPort;
}

export function createHelarcDescendantAgentContribution(
  agent: Agent<HelarcAgentOutput>,
  admittedAt: string,
  now: () => string,
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
    composition: Object.freeze({
      assessAvailability(input: Parameters<DescendantRunCompositionPort["assessAvailability"]>[0]) {
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
      async prepare(input: Parameters<DescendantRunCompositionPort["prepare"]>[0]) {
        if (input.targetAgent.id !== agent.id || input.targetAgent.revision !== agent.revision) {
          throw new TypeError("The requested descendant Agent revision is not admitted.");
        }
        const delegated = snapshotDelegatedInput(input.delegatedInput);
        const createdAt = now();
        const childInput: RunInput = Object.freeze({
          task: Object.freeze({
            id: `${input.parentRunAction.id}:task`,
            kind: "helarc.delegated-code-task",
            input: Object.freeze({ prompt: delegated.prompt }),
            createdAt,
            metadata: Object.freeze({
              parentRunId: input.parentRunId,
              description: delegated.description,
            }),
          }),
          items: Object.freeze([Object.freeze({
            id: `${input.parentRunAction.id}:input`,
            kind: "message" as const,
            role: "user" as const,
            content: delegated.prompt,
            createdAt,
            metadata: Object.freeze({ source: "parent_run_delegation" }),
          })]),
          metadata: Object.freeze({
            product: "helarc",
            parentRunId: input.parentRunId,
          }),
        });
        const parent = input.parentConfig;
        return Object.freeze({
          agent: createHelarcAgent(),
          input: childInput,
          config: Object.freeze({
            workspace: parent.workspace,
            identity: parent.identity,
            permissions: parent.permissions,
            tools: parent.tools,
            actionExecution: parent.actionExecution,
            validation: parent.validation,
            limits: parent.limits,
            audit: parent.audit,
            telemetry: parent.telemetry,
            cancellationLimits: parent.cancellationLimits,
            retry: parent.retry,
            metadata: Object.freeze({
              ...parent.metadata,
              parentRunId: input.parentRunId,
            }),
          }),
          contextManifestRef: `${input.parentRunId}:${input.parentRunAction.id}:fresh-context`,
          visibility: "parent_and_host" as const,
          mapResult: projectDescendantResult,
        });
      },
    }),
  });
}

function snapshotDelegatedInput(candidate: unknown): {
  readonly prompt: string;
  readonly description: string | null;
} {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError("Agent Tool input must be an object.");
  }
  const input = candidate as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "prompt" && key !== "description")) {
    throw new TypeError("Agent Tool input contains an unsupported field.");
  }
  const prompt = boundedText(input.prompt, 64_000, "prompt");
  const description = input.description === undefined
    ? null
    : boundedText(input.description, 1_024, "description");
  return Object.freeze({ prompt, description });
}

function projectDescendantResult(
  result: RunResult,
): import("@agent-anything/agent-runtime/runner").DescendantOperationOutcome {
  const artifacts = Object.freeze(result.artifactRefs.slice(0, 64));
  if (result.status === "succeeded") {
    const summary = isHelarcOutput(result.finalOutput)
      ? result.finalOutput.summary
      : "Descendant Run completed.";
    return Object.freeze({
      status: "succeeded" as const,
      output: Object.freeze({
        child_run_id: result.runId,
        status: "succeeded",
        summary,
        artifact_refs: artifacts,
        failure_code: null,
      }),
      failure: null,
    });
  }
  if (result.status === "blocked") {
    return Object.freeze({
      status: "partial" as const,
      output: Object.freeze({
        child_run_id: result.runId,
        status: "stopped",
        summary: "Descendant Run stopped without a safe completion path.",
        artifact_refs: artifacts,
        failure_code: result.code,
      }),
      failure: descendantFailure(result.code, "Descendant Run was blocked."),
    });
  }
  if (result.status === "cancelled") {
    return Object.freeze({
      status: "cancelled" as const,
      output: null,
      failure: descendantFailure(result.code, "Descendant Run was cancelled."),
    });
  }
  return Object.freeze({
    status: "failed" as const,
    output: null,
    failure: descendantFailure(result.code, "Descendant Run failed."),
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

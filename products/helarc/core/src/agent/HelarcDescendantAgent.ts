import type { Agent } from "@agent-anything/agent-core/agent";
import type { RunnerDelegationComposition } from "@agent-anything/agent-runtime/runner";
import {
  createDelegationContextPlan,
  createDelegationLimits,
  createDelegationResultExpectation,
  type DelegationResult,
} from "@agent-anything/agent-runtime/delegation";
import type { OperationFailure } from "@agent-anything/operation-catalog/result";
import type { ToolRegistrationInput } from "@agent-anything/tools/registration";
import type { HelarcAgentOutput } from "../controller/HelarcController.js";
import { findHelarcBaselineToolContract } from "../tools/HelarcBaselineToolContracts.js";
import {snapshotExecutionEvidenceRef, type ExecutionEvidenceRef} from "@agent-anything/operation-catalog/evidence";
import type {HelarcExecutionHandoff} from "../tools/HelarcExecutionHandoff.js";
import {snapshotContextMaterialRefs, type ContextMaterialAccessPort, type ContextMaterialRef} from "@agent-anything/context/material";
import type {HelarcMaterialHandoff} from "../tools/HelarcMaterialHandoff.js";

export interface HelarcDescendantAgentContribution {
  readonly tools: readonly ToolRegistrationInput[];
  readonly delegation: RunnerDelegationComposition;
}

export function createHelarcDescendantAgentContribution(
  agent: Agent<HelarcAgentOutput>,
  admittedAt: string,
  executionHandoff?: HelarcExecutionHandoff,
  contextMaterials?: ContextMaterialAccessPort,
  materialHandoff?: HelarcMaterialHandoff,
): HelarcDescendantAgentContribution {
  const contract = findHelarcBaselineToolContract("Agent");
  const sendMessageContract = findHelarcBaselineToolContract("SendMessage");
  return Object.freeze({
    tools: Object.freeze([Object.freeze({
      admissionId: "helarc.agent.v4",
      descriptor: Object.freeze({
        ref: Object.freeze({
          tool: Object.freeze({ namespace: "helarc", name: "agent" }),
          revision: "4",
        }),
        name: contract.name,
        description: contract.description,
        inputSchema: contract.inputSchema,
        outputSchema: contract.outputSchema,
        schemaRevisions: Object.freeze({
          dialect: "json-schema-2020-12",
          input: "3",
          output: "4",
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
        metadata: Object.freeze({ productAgentBinding: "helarc-code-agent" }),
      }),
      allowedOrigins: Object.freeze(["model" as const]),
      admittedAt,
    }), Object.freeze({
      admissionId: "helarc.send-message.v4",
      descriptor: Object.freeze({
        ref: Object.freeze({
          tool: Object.freeze({ namespace: "helarc", name: "send-message" }),
          revision: "4",
        }),
        name: sendMessageContract.name,
        description: sendMessageContract.description,
        inputSchema: sendMessageContract.inputSchema,
        outputSchema: sendMessageContract.outputSchema,
        schemaRevisions: Object.freeze({
          dialect: "json-schema-2020-12",
          input: "1",
          output: "4",
          translation: "native-1",
        }),
        annotations: sendMessageContract.annotations,
        source: Object.freeze({
          kind: "product" as const,
          sourceId: "helarc",
          sourceRevision: "1",
          activationEpoch: null,
        }),
        binding: Object.freeze({
          kind: "descendant_message" as const,
          agent: Object.freeze({ id: agent.id, revision: agent.revision }),
          revision: "descendant-message-binding-1",
        }),
        retirement: null,
        metadata: Object.freeze({ productAgentBinding: "helarc-code-agent" }),
      }),
      allowedOrigins: Object.freeze(["model" as const]),
      admittedAt,
    })]),
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
          if (delegated.materialRefs.length) {
            if (!contextMaterials) throw new TypeError("Retained material handoff is unavailable.");
            await contextMaterials.validate(input.parent.run.id, delegated.materialRefs);
          }
          if (delegated.executionRefs.length) {
            if (!executionHandoff) throw new TypeError("Execution-reference transfer is unavailable.");
            await executionHandoff.validate(input.parent.run.id, delegated.executionRefs);
          }
          const limits = createDelegationLimits({
            maxControllerTurns: input.limitCeiling.maxControllerTurns,
            maxActions: input.limitCeiling.maxActions,
            maxModelInputTokens: input.limitCeiling.maxModelInputTokens,
            maxModelOutputTokens: input.limitCeiling.maxModelOutputTokens,
            maxCostUnits: input.limitCeiling.maxCostUnits,
            maxDurationMs: input.limitCeiling.maxDurationMs,
            maxContextBytes: input.limitCeiling.maxContextBytes,
            maxResultBytes: input.limitCeiling.maxResultBytes,
          });
          return Object.freeze({
            agent,
            contextMaterials: Object.freeze([]),
            preparation: Object.freeze({
              schemaVersion: 1 as const,
              childAgent: Object.freeze({ id: agent.id, revision: agent.revision }),
              task: Object.freeze({
                kind: "helarc.delegated-code-task",
                input: Object.freeze({ prompt: delegated.prompt, ...(delegated.executionRefs.length ? {
                  execution_refs: delegated.executionRefs.map(ref => ({...ref})),
                } : {}), ...(delegated.materialRefs.length ? {material_refs: delegated.materialRefs.map(ref => ({...ref}))} : {}) }),
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
                  Object.freeze({ form: "effects" as const, required: false, maxItems: 64 }),
                ]),
                maxNarrativeCharacters: 16_000,
              }),
              contextPlan: createDelegationContextPlan({
                entries: Object.freeze([]),
                maxContextBytes: limits.maxContextBytes,
              }),
              authorityRestriction: null,
              allocationRequest: limits,
            }),
          });
        },
      }),
      continuation: Object.freeze({
        async prepare(
          input: Parameters<RunnerDelegationComposition["continuation"]["prepare"]>[0],
        ) {
          if (
            input.targetAgent.id !== agent.id ||
            input.targetAgent.revision !== agent.revision ||
            input.sourceRequest.childAgent.id !== agent.id ||
            input.sourceRequest.childAgent.revision !== agent.revision ||
            input.sourceRequest.origin.parent.run.id !== input.parentRunId ||
            input.sourceResult.request.id !== input.sourceRequest.ref.id ||
            input.sourceResult.request.revision !== input.sourceRequest.ref.revision
          ) {
            throw new TypeError("The requested descendant continuation is incompatible.");
          }
          boundedText(input.message, 64_000, "message");
          const limits = createDelegationLimits({
            maxControllerTurns: input.limitCeiling.maxControllerTurns,
            maxActions: input.limitCeiling.maxActions,
            maxModelInputTokens: input.limitCeiling.maxModelInputTokens,
            maxModelOutputTokens: input.limitCeiling.maxModelOutputTokens,
            maxCostUnits: input.limitCeiling.maxCostUnits,
            maxDurationMs: input.limitCeiling.maxDurationMs,
            maxContextBytes: input.limitCeiling.maxContextBytes,
            maxResultBytes: input.limitCeiling.maxResultBytes,
          });
          return Object.freeze({
            agent,
            contextMaterials: Object.freeze([]),
            preparation: Object.freeze({
              schemaVersion: 1 as const,
              childAgent: Object.freeze({ id: agent.id, revision: agent.revision }),
              task: input.sourceRequest.task,
              objective: Object.freeze({...input.sourceRequest.objective, text: input.message}),
              expectedResult: input.sourceRequest.expectedResult,
              contextPlan: createDelegationContextPlan({
                entries: Object.freeze([]),
                maxContextBytes: limits.maxContextBytes,
              }),
              authorityRestriction: null,
              allocationRequest: limits,
            }),
          });
        },
      }),
      narrativeProjection: Object.freeze({
        project(
          input: Parameters<RunnerDelegationComposition["narrativeProjection"]["project"]>[0],
        ) {
          if (input.childResult.status === "completed") {
            return isHelarcOutput(input.childResult.finalOutput)
              ? input.childResult.finalOutput.summary
              : null;
          }
          for (const { payload } of [...input.childResult.items].reverse()) {
            if (payload.kind !== "controller_turn") continue;
            const blocks = payload.modelItems.flatMap((item) =>
              item.kind === "assistant_text" && item.text.trim().length > 0
                ? [item.text]
                : []
            );
            if (blocks.length === 0) continue;
            const narrative = blocks.join("\n\n");
            const limit = 16_000;
            const marker = "\n[Child report truncated.]";
            return narrative.length <= limit
              ? narrative
              : narrative.slice(0, limit - marker.length) + marker;
          }
          return null;
        },
      }),
      progressProjection: Object.freeze({
        project(
          { progress }: Parameters<RunnerDelegationComposition["progressProjection"]["project"]>[0],
        ) {
          return Object.freeze({
            status: "succeeded" as const,
            output: Object.freeze({
              agent_id: progress.childRun.id,
              status: "suspended",
              child_run_revision: progress.childRunRevision,
              summary: progress.suspension.reason,
              admitted_controls: progress.admittedControls,
            }),
            failure: null,
          });
        },
      }),
      resultProjection: Object.freeze({
        async project(input: Parameters<typeof projectDescendantResult>[0]) {
          let outcome = projectDescendantResult(input);
          const materials = await materialHandoff?.project(input.result) ?? [];
          if (materials.length && outcome.output !== null) outcome = {...outcome, output: {...outcome.output as object, material_refs: materials}};
          if (!executionHandoff) return outcome;
          return executionHandoff.project(input.result).then(page => {
            if (!page.references.length) return outcome;
            const output = {...(outcome.output as object ?? {agent_id: input.continuation?.id ?? null,
              status: input.result.terminal.status, summary: input.result.narrative?.text ?? "",
              artifact_refs: input.result.artifacts.refs, effect_status: input.result.effects.status,
              uncertainty: input.result.uncertainty, failure_code: input.result.terminal.code}),
              execution_refs: page.references,
              execution_lookup: page.next ? {reference: page.references[0], view: "executions", after: page.next} : null};
            if (outcome.status === "succeeded" || outcome.status === "partial" || outcome.status === "failed") return {...outcome, output};
            return {status: "partial" as const, output, failure: outcome.failure};
          });
        },
      }),
    }),
  });
}

function snapshotDelegatedInput(candidate: unknown): {
  readonly prompt: string;
  readonly description: string | null;
  readonly executionRefs: readonly ExecutionEvidenceRef[];
  readonly materialRefs: readonly ContextMaterialRef[];
} {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError("Agent Tool input must be an object.");
  }
  const input = candidate as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "prompt" && key !== "description" && key !== "execution_refs" && key !== "material_refs")) {
    throw new TypeError("Agent Tool input contains an unsupported field.");
  }
  const prompt = boundedText(input.prompt, 64_000, "prompt");
  const description = input.description === undefined
    ? null
    : boundedText(input.description, 1_024, "description");
  const refs = input.execution_refs ?? [];
  if (!Array.isArray(refs) || refs.length > 16) throw new TypeError("execution_refs accepts at most 16 disclosed references.");
  return Object.freeze({ prompt, description, executionRefs: Object.freeze(refs.map(ref => snapshotExecutionEvidenceRef(ref))),
    materialRefs: snapshotContextMaterialRefs(input.material_refs ?? []) });
}

function projectDescendantResult(
  input: {
    readonly result: DelegationResult;
    readonly continuation: Readonly<{ readonly id: string; readonly revision: string }> | null;
  },
): import("@agent-anything/agent-runtime/runner").DescendantOperationOutcome {
  const result = input.result;
  const artifacts = result.artifacts.refs;
  const output = Object.freeze({
    agent_id: input.continuation?.id ?? null,
    status: result.terminal.status,
    summary: result.narrative?.text ?? "",
    artifact_refs: artifacts,
    effect_status: result.effects.status,
    uncertainty: result.uncertainty,
    failure_code: result.terminal.status === "failed" ? result.terminal.code : null,
    failure: result.terminal.status === "failed" ? Object.freeze({
      kind: result.terminal.failureKind,
      code: result.terminal.code,
      ...result.terminal.failureDiagnostic,
    }) : null,
  });
  const requiredMissing = result.expectationCoverage.some(
    ({ required, disposition }) => required && disposition !== "present",
  );
  const uncertain = result.effects.status === "partial" ||
    result.effects.status === "unknown" ||
    result.limitDisposition.status === "exhausted";
  if (result.terminal.status === "completed" && !requiredMissing && !uncertain) {
    return Object.freeze({
      status: "succeeded" as const,
      output,
      failure: null,
    });
  }
  if (
    result.terminal.status === "completed" ||
    output.summary.length > 0 ||
    output.artifact_refs.length > 0
  ) {
    return Object.freeze({
      status: "partial" as const,
      output,
      failure: descendantFailure(
        result.terminal.code ?? "delegation_result_incomplete",
        result.terminal.failureDiagnostic?.message ?? "Descendant result is incomplete, limited, or uncertain.",
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
    output,
    failure: descendantFailure(
      result.terminal.code ?? "descendant_run_failed",
      result.terminal.failureDiagnostic!.message,
    ),
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
  if (
    typeof candidate !== "string" || candidate.trim().length === 0 ||
    candidate.length > maxLength
  ) {
    throw new TypeError(`Agent Tool ${field} must be bounded non-empty text.`);
  }
  return candidate;
}

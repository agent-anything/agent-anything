import type {AgentDefinition} from "@agent-anything/agent-core/agent";
import type {InterpretTaskResponse, ProviderRequestBuildContext, TaskDecisionActivity, TaskDecisionInputSources, TaskDecisionSourceRecord, TaskResponseProtocol} from "@agent-anything/agent-runtime/decision";
import type {ProviderRequest} from "@agent-anything/model-interaction";
import {TaskResponseBindingError} from "@agent-anything/agent-runtime/decision";
import type {ContextPreparationLifecycle} from "@agent-anything/agent-runtime/context-representation";
import type {ModelResponseDeliveryOptions} from "@agent-anything/agent-runtime/model-access";
import type {ContextMaterialAccessPort} from "@agent-anything/context/material";
import {buildHelarcProviderRequest, parseHelarcProviderResponse, type HelarcAgentOutput} from "../controller/HelarcController.js";
import type {HelarcControllerProtocolComposition} from "../controller/HelarcControllerProtocolComposition.js";
import {restoreHelarcCallableCatalog, type HelarcModelCallableCatalog} from "../controller/HelarcModelCallableCatalog.js";
import {validateHelarcFinalMaterials} from "../tools/HelarcMaterialHandoff.js";

/** Product rules only. The Host binds execution, input supply and recovery separately. */
export interface HelarcTaskModelBinding {
  readonly buildRequest: (source: TaskDecisionInputSources<HelarcAgentOutput>, context: ProviderRequestBuildContext) => ProviderRequest;
  readonly interpret: InterpretTaskResponse<HelarcAgentOutput>;
  readonly protocol: TaskResponseProtocol;
  readonly resolveAgent: (definition: TaskDecisionSourceRecord["source"]["agent"]) => AgentDefinition<HelarcAgentOutput>;
  readonly delivery: ModelResponseDeliveryOptions;
  readonly observeRequest?: (source: TaskDecisionSourceRecord, request: ProviderRequest) => void;
}

export interface HelarcTaskExecutionComposition {
  readonly taskDecisions: TaskDecisionActivity<HelarcAgentOutput>;
  readonly preparations: ContextPreparationLifecycle;
}

export type HelarcTaskExecutionFactory = (binding: HelarcTaskModelBinding) => HelarcTaskExecutionComposition | Promise<HelarcTaskExecutionComposition>;

export function createHelarcTaskModelBinding(input: {
  readonly agents: readonly AgentDefinition<HelarcAgentOutput>[];
  readonly protocol: HelarcControllerProtocolComposition;
  readonly environment?: (runId: string) => Parameters<typeof buildHelarcProviderRequest>[3];
  readonly materials?: ContextMaterialAccessPort;
  readonly delivery: ModelResponseDeliveryOptions;
  readonly requestBound?: (runId: string, requestId: string, catalog: HelarcModelCallableCatalog) => void;
}): HelarcTaskModelBinding {
  const agents = new Map(input.agents.map(agent => [JSON.stringify([agent.id, agent.revision]), agent]));
  if (agents.size !== input.agents.length) throw new TypeError("helarc_task_agent_binding_duplicate");
  return Object.freeze<HelarcTaskModelBinding>({
    protocol: Object.freeze({kind: "native_tool_turn" as const}),
    delivery: input.delivery,
    observeRequest(source, request) {
      input.requestBound?.(source.source.runId, request.requestId, restoreHelarcCallableCatalog(request, source.source.toolExposure));
    },
    resolveAgent(definition: TaskDecisionSourceRecord["source"]["agent"]) {
      const agent = agents.get(JSON.stringify([definition.id, definition.revision]));
      if (!agent) throw new TaskResponseBindingError("helarc_task_original_agent_unavailable");
      return agent;
    },
    buildRequest(source, context) {
      const request = buildHelarcProviderRequest(source, context, input.protocol, input.environment?.(source.runId));
      input.requestBound?.(source.runId, request.requestId, restoreHelarcCallableCatalog(request, source.toolExposure));
      return request;
    },
    async interpret(response, source, request, executionFlow) {
      return parseHelarcProviderResponse(response, source, request, executionFlow,
        await validateHelarcFinalMaterials(response, source.runId, input.materials));
    },
  });
}

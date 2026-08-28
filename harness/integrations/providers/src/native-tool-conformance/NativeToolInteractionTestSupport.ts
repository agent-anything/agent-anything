import {
  createNativeToolTurnInteraction,
  type ModelCallableDefinition,
  type ModelMessage,
  type ModelToolCall,
  type Provider,
  type ProviderRequest,
} from "@agent-anything/model-interaction";
import {
  composeModelInput,
  modelMessagesFromComposition,
} from "@agent-anything/model-interaction/input";

export const NATIVE_TEST_CALLABLES: readonly ModelCallableDefinition[] = Object.freeze([
  Object.freeze({
    name: "Read",
    description: "Read one workspace file.",
    inputSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({ file_path: Object.freeze({ type: "string" }) }),
      required: Object.freeze(["file_path"]),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: "Search",
    description: "Search workspace text.",
    inputSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({ query: Object.freeze({ type: "string" }) }),
      required: Object.freeze(["query"]),
      additionalProperties: false,
    }),
  }),
]);

export function createNativeProviderRequest(
  provider: Provider,
  input: {
    readonly requestId?: string;
    readonly messages?: readonly ModelMessage[];
  } = {},
): ProviderRequest {
  const requestId = input.requestId ?? "native-request-1";
  const messages = input.messages ?? defaultMessages();
  const interaction = createNativeToolTurnInteraction(NATIVE_TEST_CALLABLES);
  const sections = messages.map((message, index) => ({
    id: `native-message-${index}`,
    source: source(`native-message-${index}`),
    kind: index === 0 && message.role === "system"
      ? "agent_instruction"
      : "interaction_history",
    role: message.role,
    necessity: "mandatory" as const,
    content: { kind: "model_message" as const, message },
  }));
  const composition = composeModelInput({
    id: requestId,
    providerId: provider.inputAccounting.providerId,
    model: provider.inputAccounting.model,
    accounting: provider.inputAccounting,
    interaction,
    outputReserve: { unit: "bytes", amount: 0 },
    contextBudget: { unit: "bytes", amount: 0 },
    contextProjectedAmount: 0,
    sections,
    lineage: {
      instructionBinding: source("binding"),
      agent: source("agent"),
      instructions: source("agent-instructions"),
      instructionRelease: source("instruction-release"),
      instructionResolver: source("instruction-resolver"),
      instructionContent: source("instruction-content"),
      instructionModel: {
        providerId: provider.inputAccounting.providerId,
        model: provider.inputAccounting.model,
      },
      instructionBlocks: [source("native-message-0")],
      activeContext: source("active-context"),
      contextProjection: source("context-projection"),
      projectionManifest: source("projection-manifest"),
      toolSelection: source("tool-selection"),
      toolExposureContent: source("tool-exposure-content"),
      toolExposureBasis: source("tool-exposure-basis"),
      toolExposureProof: source("tool-exposure-proof"),
      toolGuidance: source("tool-guidance"),
      controllerControlGuidance: source("controller-control-guidance"),
      callableDefinitions: source("callable-definitions"),
      interactionHistory: messages.length > 2 ? source("interaction-history") : null,
      protocol: source("native-tool-protocol"),
      policy: source("native-tool-policy"),
    },
    composedAt: "2026-08-27T00:00:00.000Z",
  });
  return {
    requestId: composition.id,
    purpose: "native-tool-conformance",
    correlation: {
      controllerRequestId: "controller-request-1",
      branchId: "run-1:main",
    },
    messages: modelMessagesFromComposition(composition),
    interaction: composition.interaction,
    composition,
    continuation: null,
    metadata: {},
  };
}

export function createSettledToolResultMessage(
  call: ModelToolCall,
): Extract<ModelMessage, { readonly role: "tool" }> {
  return {
    role: "tool",
    content: [{
      kind: "model_tool_result",
      result: {
        modelCallRef: call.modelCallRef,
        providerCallRef: call.providerCallRef,
        name: call.name,
        settlement: "succeeded",
        content: { text: "file contents" },
        sourceRefs: [{
          owner: "native-tool-conformance",
          kind: "tool_result",
          id: "tool-result-1",
          revision: "1",
        }],
      },
    }],
  };
}

export function defaultMessages(): readonly ModelMessage[] {
  return [{
    role: "system",
    content: [{ kind: "text", text: "Use the available callable when needed." }],
  }, {
    role: "user",
    content: [{ kind: "text", text: "Inspect package.json." }],
  }];
}

function source(id: string) {
  return {
    owner: "provider-native-conformance",
    kind: "model_input",
    id,
    revision: "1",
  };
}

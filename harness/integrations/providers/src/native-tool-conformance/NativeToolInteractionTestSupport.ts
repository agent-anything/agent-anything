import {
  createNativeToolTurnInteraction,
  type ModelCallableDefinition,
  type ModelInstructions,
  type ModelMessage,
  type ModelToolCall,
  type Provider,
  type ProviderRequest,
} from "@agent-anything/model-interaction";
import {
  composeModelInput,
  modelInputFromComposition,
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
    readonly instructions?: ModelInstructions;
    readonly messages?: readonly ModelMessage[];
  } = {},
): ProviderRequest {
  const requestId = input.requestId ?? "native-request-1";
  const instructions = input.instructions ?? defaultInstructions();
  const messages = input.messages ?? defaultMessages();
  const interaction = createNativeToolTurnInteraction(NATIVE_TEST_CALLABLES);
  const sections = [
    ...instructions.content.map((block, index) => ({
      id: `native-instruction-${index}`,
      source: source(`native-instruction-${index}`),
      kind: "agent_instruction" as const,
      role: "instruction" as const,
      necessity: "mandatory" as const,
      content: { kind: "text" as const, text: block.text },
    })),
    ...messages.map((message, index) => ({
    id: `native-message-${index}`,
    source: source(`native-message-${index}`),
    kind: "interaction_history" as const,
    role: message.role,
    necessity: "mandatory" as const,
    content: { kind: "model_message" as const, message },
    })),
  ];
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
      instructionBlocks: instructions.content.map((_, index) =>
        source(`native-instruction-${index}`)
      ),
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
      modelQualification: null,
      interactionHistory: messages.length > 2 ? source("interaction-history") : null,
      protocol: source("native-tool-protocol"),
      policy: source("native-tool-policy"),
    },
    composedAt: "2026-08-27T00:00:00.000Z",
  });
  const modelInput = modelInputFromComposition(composition);
  return {
    requestId: composition.id,
    purpose: "native-tool-conformance",
    correlation: {
      controllerRequestId: "controller-request-1",
      branchId: "run-1:main",
    },
    instructions: modelInput.instructions,
    messages: modelInput.messages,
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
    role: "user",
    content: [{ kind: "text", text: "Inspect package.json." }],
  }];
}

export function defaultInstructions(): ModelInstructions {
  return {
    content: [{ kind: "text", text: "Use the available callable when needed." }],
  };
}

function source(id: string) {
  return {
    owner: "provider-native-conformance",
    kind: "model_input",
    id,
    revision: "1",
  };
}

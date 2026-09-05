import type { ModelJsonValue } from "../ModelInteractionContractValidation.js";
import {
  modelInstructionsEqual,
  snapshotModelInstructions,
  type ModelInstructions,
} from "../ModelInstructions.js";
import {
  modelMessagesEqual,
  snapshotModelMessages,
  type ModelMessage,
} from "../ModelMessage.js";
import {
  snapshotProviderInteraction,
  type ProviderInteraction,
} from "../ProviderInteraction.js";
import {
  isoDateTime,
  nullableToken,
  snapshotJsonValue,
  strictRecord,
  token,
} from "../ModelInteractionContractValidation.js";

export interface ModelInputSourceRef {
  readonly owner: string;
  readonly kind: string;
  readonly id: string;
  readonly revision: string | null;
}

export interface ModelInputTextContent {
  readonly kind: "text";
  readonly text: string;
}

export interface ModelInputStructuredContent {
  readonly kind: "structured";
  readonly value: ModelJsonValue;
}

export interface ModelInputMessageContent {
  readonly kind: "model_message";
  readonly message: ModelMessage;
}

export type ModelInputContent =
  | ModelInputTextContent
  | ModelInputStructuredContent
  | ModelInputMessageContent;

export type ModelInputSectionRole = "instruction" | "user" | "assistant" | "tool";

export interface ModelInputSection {
  readonly id: string;
  readonly source: ModelInputSourceRef;
  readonly kind: string;
  readonly role: ModelInputSectionRole;
  readonly necessity: "mandatory" | "optional";
  readonly content: ModelInputContent;
}

export interface ModelInputLineage {
  readonly instructionBinding: ModelInputSourceRef;
  readonly agent: ModelInputSourceRef;
  readonly instructions: ModelInputSourceRef;
  readonly instructionRelease: ModelInputSourceRef;
  readonly instructionResolver: ModelInputSourceRef;
  readonly instructionContent: ModelInputSourceRef;
  readonly instructionModel: {
    readonly providerId: string;
    readonly model: string;
  };
  readonly instructionBlocks: readonly ModelInputSourceRef[];
  readonly activeContext: ModelInputSourceRef | null;
  readonly contextProjection: ModelInputSourceRef | null;
  readonly projectionManifest: ModelInputSourceRef | null;
  readonly toolSelection: ModelInputSourceRef | null;
  readonly toolExposureContent: ModelInputSourceRef | null;
  readonly toolExposureBasis: ModelInputSourceRef | null;
  readonly toolExposureProof: ModelInputSourceRef | null;
  readonly toolGuidance: ModelInputSourceRef | null;
  readonly controllerControlGuidance: ModelInputSourceRef | null;
  readonly callableDefinitions: ModelInputSourceRef | null;
  readonly modelQualification: ModelInputSourceRef | null;
  readonly interactionHistory: ModelInputSourceRef | null;
  readonly protocol: ModelInputSourceRef;
  readonly policy: ModelInputSourceRef;
}

export interface ModelInputComposition {
  readonly id: string;
  readonly providerId: string;
  readonly model: string;
  readonly interaction: ProviderInteraction;
  readonly sections: readonly ModelInputSection[];
  readonly instructions: ModelInstructions;
  readonly messages: readonly ModelMessage[];
  readonly lineage: ModelInputLineage;
  readonly composedAt: string;
}

export function snapshotModelInputComposition(
  input: ModelInputComposition,
): ModelInputComposition {
  strictRecord(input, "ModelInputComposition", [
    "id", "providerId", "model", "interaction", "sections", "instructions", "messages",
    "lineage", "composedAt",
  ]);
  const interaction = snapshotProviderInteraction(input.interaction);
  if (!Array.isArray(input.sections) || input.sections.length === 0) {
    throw new TypeError("ModelInputComposition.sections must be non-empty.");
  }
  const sections = input.sections.map((section, index) =>
    snapshotSection(section, `ModelInputComposition.sections[${index}]`),
  );
  if (new Set(sections.map((section) => section.id)).size !== sections.length) {
    throw new TypeError("ModelInputComposition section identities must be unique.");
  }
  const projectedInput = modelInputFromSections(sections);
  const instructions = snapshotModelInstructions(input.instructions);
  const messages = snapshotModelMessages(input.messages);
  if (
    !modelInstructionsEqual(instructions, projectedInput.instructions) ||
    !modelMessagesEqual(messages, projectedInput.messages)
  ) {
    throw new TypeError("ModelInputComposition input diverges from its sections.");
  }
  const lineage = snapshotLineage(input.lineage);
  assertInstructionLineage({
    providerId: input.providerId,
    model: input.model,
    sections,
    lineage,
  });
  return Object.freeze({
    id: token(input.id, "ModelInputComposition.id"),
    providerId: token(input.providerId, "ModelInputComposition.providerId"),
    model: token(input.model, "ModelInputComposition.model"),
    interaction,
    sections: Object.freeze(sections),
    instructions,
    messages,
    lineage,
    composedAt: isoDateTime(input.composedAt, "ModelInputComposition.composedAt"),
  });
}

function assertInstructionLineage(input: {
  readonly providerId: string;
  readonly model: string;
  readonly sections: readonly ModelInputSection[];
  readonly lineage: ModelInputLineage;
}): void {
  if (
    input.lineage.instructionModel.providerId !== input.providerId ||
    input.lineage.instructionModel.model !== input.model
  ) {
    throw new TypeError("Model input instruction lineage must match the Provider model identity.");
  }
  const instructionSections = input.sections.filter(
    (section) => section.kind === "agent_instruction",
  );
  if (instructionSections.length !== input.lineage.instructionBlocks.length) {
    throw new TypeError("Model input instruction sections must match instruction block lineage.");
  }
  for (let index = 0; index < instructionSections.length; index += 1) {
    const section = instructionSections[index]!;
    const source = input.lineage.instructionBlocks[index]!;
    if (
      input.sections[index] !== section ||
      section.role !== "instruction" ||
      section.necessity !== "mandatory" ||
      !sameSource(section.source, source)
    ) {
      throw new TypeError(
        "Agent instruction sections must be the leading ordered mandatory instruction sections.",
      );
    }
  }
}

function sameSource(left: ModelInputSourceRef, right: ModelInputSourceRef): boolean {
  return left.owner === right.owner &&
    left.kind === right.kind &&
    left.id === right.id &&
    left.revision === right.revision;
}

function snapshotSection(
  input: ModelInputSection,
  path: string,
): ModelInputSection {
  strictRecord(input, path, [
    "id", "source", "kind", "role", "necessity", "content",
  ]);
  if (!isRole(input.role)) throw new TypeError(`${path}.role is invalid.`);
  if (input.necessity !== "mandatory" && input.necessity !== "optional") {
    throw new TypeError(`${path}.necessity is invalid.`);
  }
  return Object.freeze({
    id: token(input.id, `${path}.id`),
    source: snapshotSource(input.source, `${path}.source`),
    kind: token(input.kind, `${path}.kind`),
    role: input.role,
    necessity: input.necessity,
    content: snapshotContent(input.content, `${path}.content`),
  });
}

function snapshotContent(input: ModelInputContent, path: string): ModelInputContent {
  strictRecord(input, path, ["kind", "text", "value", "message"]);
  if (input.kind === "text") {
    strictRecord(input, path, ["kind", "text"]);
    if (typeof input.text !== "string") throw new TypeError(`${path}.text must be a string.`);
    return Object.freeze({ kind: "text", text: input.text });
  }
  if (input.kind === "structured") {
    strictRecord(input, path, ["kind", "value"]);
    return Object.freeze({
      kind: "structured",
      value: snapshotJsonValue(input.value, `${path}.value`),
    });
  }
  if (input.kind === "model_message") {
    strictRecord(input, path, ["kind", "message"]);
    return Object.freeze({
      kind: "model_message",
      message: snapshotModelMessages([input.message])[0]!,
    });
  }
  throw new TypeError(`${path}.kind is invalid.`);
}

function snapshotLineage(input: ModelInputLineage): ModelInputLineage {
  strictRecord(input, "ModelInputComposition.lineage", [
    "instructionBinding", "agent", "instructions", "instructionRelease",
    "instructionResolver", "instructionContent", "instructionModel", "instructionBlocks",
    "activeContext", "contextProjection", "projectionManifest", "toolSelection",
    "toolExposureContent", "toolExposureBasis", "toolExposureProof", "toolGuidance",
    "controllerControlGuidance", "callableDefinitions", "modelQualification",
    "interactionHistory",
    "protocol", "policy",
  ]);
  return Object.freeze({
    instructionBinding: snapshotSource(input.instructionBinding, "ModelInputComposition.lineage.instructionBinding"),
    agent: snapshotSource(input.agent, "ModelInputComposition.lineage.agent"),
    instructions: snapshotSource(input.instructions, "ModelInputComposition.lineage.instructions"),
    instructionRelease: snapshotSource(input.instructionRelease, "ModelInputComposition.lineage.instructionRelease"),
    instructionResolver: snapshotSource(input.instructionResolver, "ModelInputComposition.lineage.instructionResolver"),
    instructionContent: snapshotSource(input.instructionContent, "ModelInputComposition.lineage.instructionContent"),
    instructionModel: snapshotInstructionModel(input.instructionModel),
    instructionBlocks: snapshotSourceList(
      input.instructionBlocks,
      "ModelInputComposition.lineage.instructionBlocks",
    ),
    activeContext: snapshotNullableSource(input.activeContext, "ModelInputComposition.lineage.activeContext"),
    contextProjection: snapshotNullableSource(input.contextProjection, "ModelInputComposition.lineage.contextProjection"),
    projectionManifest: snapshotNullableSource(input.projectionManifest, "ModelInputComposition.lineage.projectionManifest"),
    toolSelection: snapshotNullableSource(input.toolSelection, "ModelInputComposition.lineage.toolSelection"),
    toolExposureContent: snapshotNullableSource(input.toolExposureContent, "ModelInputComposition.lineage.toolExposureContent"),
    toolExposureBasis: snapshotNullableSource(input.toolExposureBasis, "ModelInputComposition.lineage.toolExposureBasis"),
    toolExposureProof: snapshotNullableSource(input.toolExposureProof, "ModelInputComposition.lineage.toolExposureProof"),
    toolGuidance: snapshotNullableSource(input.toolGuidance, "ModelInputComposition.lineage.toolGuidance"),
    controllerControlGuidance: snapshotNullableSource(input.controllerControlGuidance, "ModelInputComposition.lineage.controllerControlGuidance"),
    callableDefinitions: snapshotNullableSource(input.callableDefinitions, "ModelInputComposition.lineage.callableDefinitions"),
    modelQualification: snapshotNullableSource(input.modelQualification, "ModelInputComposition.lineage.modelQualification"),
    interactionHistory: snapshotNullableSource(input.interactionHistory, "ModelInputComposition.lineage.interactionHistory"),
    protocol: snapshotSource(input.protocol, "ModelInputComposition.lineage.protocol"),
    policy: snapshotSource(input.policy, "ModelInputComposition.lineage.policy"),
  });
}

function snapshotInstructionModel(
  input: ModelInputLineage["instructionModel"],
): ModelInputLineage["instructionModel"] {
  strictRecord(input, "ModelInputComposition.lineage.instructionModel", ["providerId", "model"]);
  return Object.freeze({
    providerId: token(input.providerId, "ModelInputComposition.lineage.instructionModel.providerId"),
    model: token(input.model, "ModelInputComposition.lineage.instructionModel.model"),
  });
}

function snapshotSourceList(
  input: readonly ModelInputSourceRef[],
  path: string,
): readonly ModelInputSourceRef[] {
  if (!Array.isArray(input)) {
    throw new TypeError(`${path} must be an array.`);
  }
  return Object.freeze(input.map((source, index) => snapshotSource(source, `${path}[${index}]`)));
}

function snapshotNullableSource(input: ModelInputSourceRef | null, path: string): ModelInputSourceRef | null {
  return input === null ? null : snapshotSource(input, path);
}

function snapshotSource(input: ModelInputSourceRef, path: string): ModelInputSourceRef {
  strictRecord(input, path, ["owner", "kind", "id", "revision"]);
  return Object.freeze({
    owner: token(input.owner, `${path}.owner`),
    kind: token(input.kind, `${path}.kind`),
    id: token(input.id, `${path}.id`),
    revision: nullableToken(input.revision, `${path}.revision`),
  });
}

function isRole(value: unknown): value is ModelInputSectionRole {
  return value === "instruction" || value === "user" || value === "assistant" || value === "tool";
}

export function modelInputFromSections(
  sections: readonly ModelInputSection[],
): {
  readonly instructions: ModelInstructions;
  readonly messages: readonly ModelMessage[];
} {
  const instructionContent: Array<{ kind: "text"; text: string }> = [];
  const messages: ModelMessage[] = [];
  let userContent: Array<{ kind: "text"; text: string }> = [];
  let conversationStarted = false;

  const flushUser = (): void => {
    if (userContent.length === 0) return;
    messages.push({
      role: "user",
      content: userContent,
    });
    userContent = [];
  };

  for (const section of sections) {
    if (section.role === "instruction") {
      if (conversationStarted) {
        throw new TypeError("Model input instruction sections must precede conversation sections.");
      }
      if (section.content.kind === "model_message") {
        throw new TypeError("Model input instructions cannot contain Conversation Messages.");
      }
      instructionContent.push({
        kind: "text",
        text: section.content.kind === "text"
          ? section.content.text
          : JSON.stringify(section.content.value),
      });
      continue;
    }
    conversationStarted = true;
    if (section.content.kind === "model_message") {
      if (section.content.message.role !== section.role) {
        throw new TypeError("Model input message content role must match its section role.");
      }
      if (section.content.message.role === "user") {
        userContent.push(...section.content.message.content);
        continue;
      }
      flushUser();
      messages.push(section.content.message);
      continue;
    }
    if (section.role === "tool") {
      throw new TypeError("Tool model-input sections require correlated result blocks.");
    }
    const text = section.content.kind === "text"
      ? section.content.text
      : JSON.stringify(section.content.value);
    if (section.role === "user") {
      userContent.push({ kind: "text", text });
      continue;
    }
    flushUser();
    messages.push({
      role: "assistant",
      content: [{ kind: "text", text }],
    });
  }
  flushUser();
  return Object.freeze({
    instructions: snapshotModelInstructions({ content: instructionContent }),
    messages: snapshotModelMessages(messages),
  });
}

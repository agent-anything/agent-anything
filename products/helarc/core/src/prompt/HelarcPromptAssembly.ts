import type {
  TaskDecisionInputSources,
  TaskDecisionSourceBasis,
} from "@agent-anything/agent-runtime/decision";
import { createInputDeliverySections, canonicalConversationPresentations } from "@agent-anything/agent-runtime/decision";
import type {
  ContextProjectionEstimationInput,
} from "@agent-anything/context/projection";
import type { ModelInputSectionCandidate } from "@agent-anything/model-interaction/input";
import { createHash } from "node:crypto";
import {
  HELARC_DEFAULT_PROTOCOL_INSTRUCTIONS,
  type HelarcInstructionSectionSetting,
} from "../instructions/HelarcProtocolInstructions.js";
import { helarcConversationOpening, renderHelarcSelectedMaterial, type HelarcExecutionBackground } from "./HelarcConversationOpening.js";

export const HELARC_PROMPT_ARCHITECTURE_VERSION = "helarc-prompt-v10";
export const HELARC_TOOL_EXPOSURE_VERSION = "trusted-tool-exposure-v1";
export const HELARC_CONTEXT_PROJECTION_FORMAT_VERSION = "helarc-context-projection-v3";
export interface HelarcPromptSection {
  readonly id: string;
  readonly source: ModelInputSectionCandidate["source"];
  readonly kind: "agent_instruction" | "product_protocol";
  readonly role: ModelInputSectionCandidate["role"];
  readonly necessity: ModelInputSectionCandidate["necessity"];
  readonly content: string;
}

export interface HelarcPromptAssemblyVersions {
  promptArchitectureVersion: typeof HELARC_PROMPT_ARCHITECTURE_VERSION;
  toolExposureVersion: typeof HELARC_TOOL_EXPOSURE_VERSION;
  contextProjectionFormatVersion: typeof HELARC_CONTEXT_PROJECTION_FORMAT_VERSION;
}

export interface HelarcPromptAssemblyResult {
  readonly sections: readonly ModelInputSectionCandidate[];
  readonly promptSections: readonly HelarcPromptSection[];
  readonly exposedToolNames: readonly string[];
  readonly versions: HelarcPromptAssemblyVersions;
}

export function buildHelarcPromptAssembly(input: {
  readonly controllerInput: TaskDecisionInputSources;
  readonly protocolInstructions?: readonly HelarcInstructionSectionSetting[];
  readonly executionBackground?: HelarcExecutionBackground;
}): HelarcPromptAssemblyResult {
  return assemble(
    input.controllerInput,
    input.protocolInstructions ?? HELARC_DEFAULT_PROTOCOL_INSTRUCTIONS,
    input.executionBackground,
  );
}

export function renderHelarcContextProjectionFragment(
  input: ContextProjectionEstimationInput,
): string {
  return renderHelarcSelectedMaterial(input);
}

function assemble(
  input: TaskDecisionSourceBasis | TaskDecisionInputSources,
  protocolInstructions: readonly HelarcInstructionSectionSetting[],
  executionBackground?: HelarcExecutionBackground,
): HelarcPromptAssemblyResult {
  const exposedToolNames = Object.freeze(input.toolExposure.catalog.tools.map((tool) => tool.name));
  const promptSections = Object.freeze([
    ...buildAgentInstructionSections(input),
    ...buildSystemPromptSections(protocolInstructions),
  ]);
  const sections = Object.freeze([
    ...promptSections.map(toModelInputSection),
    ...helarcConversationOpening(input, executionBackground),
    ...interactionHistorySections(input),
    ...createInputDeliverySections(input.inputDelivery),
  ]);
  return Object.freeze({
    sections,
    promptSections,
    exposedToolNames,
    versions: Object.freeze({
      promptArchitectureVersion: HELARC_PROMPT_ARCHITECTURE_VERSION,
      toolExposureVersion: HELARC_TOOL_EXPOSURE_VERSION,
      contextProjectionFormatVersion: HELARC_CONTEXT_PROJECTION_FORMAT_VERSION,
    }),
  });
}

function buildSystemPromptSections(
  entries: readonly HelarcInstructionSectionSetting[],
): readonly HelarcPromptSection[] {
  return Object.freeze(entries
    .filter(({ enabled, content }) => enabled && content.trim().length > 0)
    .map(({ id, content }) => {
      const revision = `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
      return Object.freeze({
        id,
        source: Object.freeze({ owner: "helarc", kind: "product_protocol", id: `helarc.protocol-instructions.${id}`, revision }),
        kind: "product_protocol" as const,
        role: "instruction" as const,
        necessity: "mandatory" as const,
        content,
      });
    }));
}

function interactionHistorySections(
  input: TaskDecisionSourceBasis | TaskDecisionInputSources,
): readonly ModelInputSectionCandidate[] {
  if (!("interaction" in input)) return Object.freeze([]);
  const openingIds = new Set(input.interaction.opening?.presentations.map(value => value.section.id) ?? []);
  const selected = canonicalConversationPresentations(input.interaction).filter(value => !openingIds.has(value.section.id));
  const messages = new Map(input.interaction.historyPresentations?.map((value, index) =>
    [value.section.id, input.interaction.messages[index]]));
  return Object.freeze(selected.map(retained => {
    const message = messages.get(retained.section.id);
    if (retained.section.content.kind !== "model_message" || JSON.stringify(retained.section.content.message) !== JSON.stringify(message)) {
      throw new TypeError("Model history requires its exact retained presentation.");
    }
    return Object.freeze({...retained.section, kind: "interaction_history", provenance: {...retained.section.provenance!,
      retainedPresentation: {owner: "agent-runtime", kind: "presentation", id: retained.section.id,
        revision: retained.digest, runId: input.runId}}});
  }));
}

function buildAgentInstructionSections(
  input: TaskDecisionSourceBasis | TaskDecisionInputSources,
): readonly HelarcPromptSection[] {
  return Object.freeze(input.agent.instructions.blocks.map((block) => Object.freeze({
    id: `agent-instructions:${block.id}`,
    source: Object.freeze({
      owner: block.source.owner,
      kind: block.source.kind,
      id: block.source.id,
      revision: block.source.revision,
    }),
    kind: "agent_instruction" as const,
    role: "instruction" as const,
    necessity: "mandatory" as const,
    content: block.content,
  })));
}

function toModelInputSection(
  section: HelarcPromptSection,
): ModelInputSectionCandidate {
  return Object.freeze({
    id: `helarc:model-input:${section.id}`,
    source: section.source,
    kind: section.kind,
    role: section.role,
    necessity: section.necessity,
    content: Object.freeze({ kind: "text" as const, text: section.content }),
  });
}

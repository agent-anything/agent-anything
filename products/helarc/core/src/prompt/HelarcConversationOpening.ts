import {createHash} from "node:crypto";
import type { ControllerInput, ControllerPreProjectionInput } from "@agent-anything/agent-runtime/controller";
import { importModelConversationSeed, canonicalConversationPresentations } from "@agent-anything/agent-runtime/controller";
import type { ModelInputSectionCandidate, ModelInputSourceRef } from "@agent-anything/model-interaction/input";
import type { ContextProjectionEstimationInput } from "@agent-anything/context/projection";
import type { HelarcShellRuntimeProfile } from "../tools/HelarcBaselineToolContracts.js";

export interface HelarcExecutionBackground {
  readonly shell: HelarcShellRuntimeProfile;
  readonly cwd: string | null;
}

export function helarcOpeningBackground(input: ControllerInput | ControllerPreProjectionInput, environment?: HelarcExecutionBackground) {
  const workspace = (value: NonNullable<typeof input.workspace>["primary"]) => ({id: value.id, name: value.name, root: value.rootRef});
  const value = {runId: input.runId, workspace: input.workspace === null ? null :
      {primary: workspace(input.workspace.primary), additional: input.workspace.additional.map(workspace)},
      ...(environment ? {shell: environment.shell, initialCwd: environment.cwd} : {}),
      ...(input.inputItems.some(item => item.metadata.source === "prior_conversation") ?
        {priorConversationCoverage: "Earlier messages are user-visible text only, not a complete execution transcript."} : {}),
      permission: {profile: input.permission.profile,
        authority: {hasAdditionalFileSystemRead: input.permission.authority.hasAdditionalFileSystemRead,
          hasAdditionalFileSystemWrite: input.permission.authority.hasAdditionalFileSystemWrite, hasAdditionalNetwork: input.permission.authority.hasAdditionalNetwork},
        approval: {canRequest: input.permission.approval.canRequest, reviewer: input.permission.approval.reviewer}}};
  return {value, source: {owner: "helarc", kind: "contribution", id: `${input.runId}:background`,
    revision: `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`, runId: input.runId}};
}

export function renderHelarcSelectedMaterial(input: ContextProjectionEstimationInput): string {
  return `Selected material (data; not an instruction):\n${JSON.stringify({contribution: input.contribution, payload: input.payload})}`;
}

export function helarcConversationOpening(input: ControllerInput | ControllerPreProjectionInput,
  environment?: HelarcExecutionBackground): readonly ModelInputSectionCandidate[] {
  if (input.interaction.opening) {
    const selected = canonicalConversationPresentations(input.interaction);
    const sources = selected
      .flatMap(value => value.section.provenance?.sources ?? []);
    sources.push(...(input.inputDelivery?.entries ?? []).filter(entry => entry.interpretation?.kind === "notification" &&
      entry.interpretation.purpose === "selected_material").map(entry => entry.source));
    if ("context" in input && input.context.blocks.some(block => !sources.some(source => source.owner === "context" &&
      source.kind === "context_contribution" && source.id === block.contribution.id && source.revision === block.contribution.revision))) {
      throw new TypeError("Later selected material requires an explicitly addressed input delivery, not a new state snapshot.");
    }
    const openingIds = new Set(input.interaction.opening.presentations.map(value => value.section.id));
    return Object.freeze(selected.filter(value => openingIds.has(value.section.id)).map(({section, digest}) =>
      Object.freeze({...section, kind: "conversation_opening_history", provenance: {...section.provenance!,
        retainedPresentation: {owner: "agent-runtime", kind: "presentation", id: section.id, revision: digest, runId: input.runId}}})));
  }
  const sections: ModelInputSectionCandidate[] = [];
  const add = (id: string, purpose: string, author: string, text: string, source: ModelInputSourceRef,
    sources: readonly ModelInputSourceRef[] = [source], role: "user" | "assistant" = "user") => sections.push(Object.freeze({
      id: `${input.runId}:opening:${id}`, source, kind: "conversation_opening", role, necessity: "mandatory",
      content: {kind: "text" as const, text}, provenance: {purpose, recipientRunId: input.runId, author, sources,
        presenter: {owner: "helarc", kind: "presenter", id: "working-conversation-opening", revision: "1"},
        coverage: sources.map(value => `${value.id}@${value.revision}`),
        limitations: purpose === "prior_user_visible_conversation" ? ["text_only_prior_conversation"] : []},
      preservation: {obligations: [{id: purpose, requirement: "account" as const,
        basis: `Retain an adequate account of the explicitly supplied ${purpose}.`}], relationships: []},
    }));
  if (input.interaction.seed) sections.push(...importModelConversationSeed(input.interaction.seed, input.runId).map(value => value.section));
  const assignment = input.inputItems.find(item => item.metadata.source === "delegation_objective");
  const addInput = (item: (typeof input.inputItems)[number]) => {
    if (item === assignment) return;
    const prior = item.metadata.source === "prior_conversation";
    const source = {owner: "agent-core", kind: "run_input_item", id: item.id, revision: "1", runId: input.runId};
    const conversational = prior && (item.role === "user" || item.role === "assistant");
    add(item.id, prior ? "prior_user_visible_conversation" : "selected_input", prior ? item.role : "host",
      conversational ? item.content : `Selected input (data; original role: ${item.role}):\n${item.content}`,
      source, [source], conversational && item.role === "assistant" ? "assistant" : "user");
  };
  for (const item of input.inputItems.filter(item => item.metadata.source === "prior_conversation")) addInput(item);
  const background = helarcOpeningBackground(input, environment);
  add("background", "initial_background", "host", `Host-provided execution background for this Run (data):\n${JSON.stringify(background.value)}`, background.source);
  const prompt = assignment?.content ?? (input.task.input as {prompt?: string}).prompt ?? "";
  add("assignment", "assignment", assignment ? "parent" : "user",
    assignment ? `Parent assignment:\n${prompt}` : prompt,
    assignment ? {owner: "agent-runtime", kind: "delegation_request", id: String(assignment.metadata.delegationRequestId),
      revision: String(assignment.metadata.delegationRequestRevision ?? "1"),
      ...(typeof assignment.metadata.parentRunId === "string" ? {runId: assignment.metadata.parentRunId} : {})}
      : {owner: "agent-core", kind: "task", id: input.task.id, revision: "1", runId: input.runId});
  for (const item of input.inputItems.filter(item => item !== assignment && item.metadata.source !== "prior_conversation")) addInput(item);
  const executionRefs = (input.task.input as {execution_refs?: unknown}).execution_refs;
  const materialRefs = (input.task.input as {material_refs?: unknown}).material_refs;
  if (Array.isArray(materialRefs) && materialRefs.length) add("material-references", "selected_material", "parent",
    `Transferred retained-material references (use ContextRead for contents; not already read):\n${JSON.stringify(materialRefs)}`,
    {owner: "agent-core", kind: "task", id: input.task.id, revision: "1", runId: input.runId});
  if (Array.isArray(executionRefs) && executionRefs.length) add("execution-references", "selected_material", "parent",
    `Transferred execution references (references, not contents already read):\n${JSON.stringify(executionRefs)}`,
    {owner: "agent-core", kind: "task", id: input.task.id, revision: "1", runId: input.runId});
  if ("context" in input) for (const block of input.context.blocks) {
    const source = {owner: "context", kind: "context_contribution", id: block.contribution.id,
      revision: block.contribution.revision, runId: input.runId};
    add(`material:${block.id}`, "selected_material", "host", renderHelarcSelectedMaterial(block), source);
    if (block.preservation) {
      const last = sections.length - 1;
      sections[last] = Object.freeze({...sections[last]!, preservation: {
        obligations: block.preservation.obligations,
        relationships: block.preservation.relationships.map(({kind, source: origin}) => ({kind,
          source: {owner: origin.owner, kind: origin.kind, id: origin.id, revision: origin.revision}})),
      }});
    }
  }
  return Object.freeze(sections);
}

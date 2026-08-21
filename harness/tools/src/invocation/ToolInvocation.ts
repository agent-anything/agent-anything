import type { RunActionRef } from "@agent-anything/agent-core/run-action";
import { createToolContractIdentity, toolRevisionKey, type ToolBindingRef, type ToolRevisionRef } from "../identity/index.js";
import { findSelectedTool, type ToolExposureProof, type ToolRequestOrigin, type ToolSelectionRevision } from "../selection/index.js";

export interface ToolCallCandidate {
  readonly name: string;
  readonly revision: string | null;
  readonly input: unknown;
  readonly origin: ToolRequestOrigin;
  readonly controllerRequestId: string | null;
}

export interface ToolCall<TInput = unknown> {
  readonly toolCallId: string;
  readonly parentRunAction: RunActionRef;
  readonly toolRevision: ToolRevisionRef;
  readonly binding: ToolBindingRef;
  readonly selectionRevision: string;
  readonly exposureProofId: string | null;
  readonly origin: ToolRequestOrigin;
  readonly input: TInput;
  readonly inputDigest: string;
  readonly createdAt: string;
}

export type ToolCallMaterialization =
  | { readonly status: "trusted"; readonly call: ToolCall }
  | { readonly status: "rejected"; readonly code: string; readonly message: string };

export function materializeToolCall(input: {
  readonly candidate: ToolCallCandidate;
  readonly selection: ToolSelectionRevision;
  readonly exposure: ToolExposureProof | null;
  readonly parentRunAction: RunActionRef;
  readonly toolCallId: string;
  readonly createdAt: string;
  readonly validateInput: (schema: unknown, candidate: unknown) => boolean;
}): ToolCallMaterialization {
  const selected = findSelectedTool(input.selection, input.candidate.name, input.candidate.origin);
  if (selected === undefined) return rejected("tool_unavailable", "The requested Tool is not selected for this origin.");
  const descriptor = selected.registration.descriptor;
  if (input.candidate.revision !== null && input.candidate.revision !== descriptor.ref.revision) return rejected("tool_revision_mismatch", "The requested Tool revision is not selected.");
  if (descriptor.retirement !== null) return rejected("tool_retired", "The requested Tool revision is retired.");
  if (input.candidate.origin === "model") {
    if (input.exposure === null || input.exposure.selectionRevision !== input.selection.revision ||
      input.candidate.controllerRequestId !== input.exposure.controllerRequestId ||
      !input.exposure.exposedTools.some((ref) => toolRevisionKey(ref) === toolRevisionKey(descriptor.ref))) {
      return rejected("tool_not_exposed", "The requested Tool was not exposed to this Controller request.");
    }
  }
  if (!input.validateInput(descriptor.inputSchema, input.candidate.input)) return rejected("tool_input_invalid", "The Tool input does not satisfy the selected schema revision.");
  const inputDigest = createToolContractIdentity("agent-anything.tool-call-input.v1", input.candidate.input);
  return Object.freeze({
    status: "trusted" as const,
    call: Object.freeze({
      toolCallId: token(input.toolCallId),
      parentRunAction: input.parentRunAction,
      toolRevision: descriptor.ref,
      binding: descriptor.binding,
      selectionRevision: input.selection.revision,
      exposureProofId: input.candidate.origin === "model" ? input.exposure!.id : null,
      origin: input.candidate.origin,
      input: deepFreeze(input.candidate.input),
      inputDigest,
      createdAt: dateTime(input.createdAt),
    }),
  });
}

export function validateExactToolCall(call: ToolCall, selection: ToolSelectionRevision): boolean {
  const selected = findSelectedTool(selection, call.toolRevision, call.origin);
  return selected !== undefined && selection.revision === call.selectionRevision &&
    createToolContractIdentity("agent-anything.tool-binding.v1", selected.registration.descriptor.binding) ===
      createToolContractIdentity("agent-anything.tool-binding.v1", call.binding);
}

function rejected(code: string, message: string): ToolCallMaterialization {
  return Object.freeze({ status: "rejected" as const, code, message });
}

function token(input: unknown): string {
  if (typeof input !== "string" || input.length === 0 || input !== input.trim()) throw new TypeError("Tool Call identity must be a canonical token.");
  return input;
}

function dateTime(input: unknown): string {
  if (typeof input !== "string" || Number.isNaN(Date.parse(input)) || new Date(input).toISOString() !== input) throw new TypeError("Tool Call creation time must be an ISO timestamp.");
  return input;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

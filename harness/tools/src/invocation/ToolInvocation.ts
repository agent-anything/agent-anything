import type { RunActionRef } from "@agent-anything/agent-core/run-action";
import { createToolContractIdentity, toolRevisionKey, type ToolBindingRef, type ToolRevisionRef } from "../identity/index.js";
import { findSelectedTool, type ToolExposureProof, type ToolRequestOrigin, type ToolSelectionRevision } from "../selection/index.js";
import {
  validateToolInput,
  type ToolInputSemanticValidator,
  type ToolInputValidationFailure,
} from "../validation/index.js";

export interface ToolCallCandidate {
  readonly name: string;
  readonly revision: string | null;
  readonly input: unknown;
  readonly origin: ToolRequestOrigin;
  readonly controllerRequestId: string | null;
}

export interface ToolCall<TInput = unknown> {
  readonly toolCallId: string;
  readonly attempt: ToolCallAttemptRef;
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

export interface ToolCallAttemptRef {
  readonly id: string;
  readonly runAction: RunActionRef;
  readonly modelCall: ToolCallModelCorrelationRef | null;
}

export interface ToolCallModelCorrelationRef {
  readonly id: string;
  readonly controllerRequestId: string;
}

export interface ToolCallAttempt {
  readonly ref: ToolCallAttemptRef;
  readonly requestedName: string;
  readonly requestedRevision: string | null;
  readonly selectedTool: ToolRevisionRef | null;
  readonly origin: ToolRequestOrigin;
  readonly inputDigest: string;
  readonly createdAt: string;
}

export type ToolCallMaterialization =
  | { readonly status: "trusted"; readonly attempt: ToolCallAttempt; readonly call: ToolCall }
  | {
      readonly status: "rejected";
      readonly attempt: ToolCallAttempt;
      readonly code: string;
      readonly message: string;
      readonly validation: ToolInputValidationFailure | null;
    };

export interface ToolCallAdmissionInput {
  readonly candidate: ToolCallCandidate;
  readonly selection: ToolSelectionRevision;
  readonly exposure: ToolExposureProof | null;
  readonly modelCall: ToolCallModelCorrelationRef | null;
  readonly semanticValidators?: readonly ToolInputSemanticValidator[];
}

export type ToolCallAdmission = {
  readonly candidate: ToolCallCandidate;
  readonly modelCall: ToolCallModelCorrelationRef | null;
  readonly selectedTool: ToolRevisionRef | null;
  readonly inputDigest: string;
} & (
  | { readonly status: "trusted"; readonly binding: ToolBindingRef; readonly selectionRevision: string; readonly exposureProofId: string | null }
  | { readonly status: "rejected"; readonly code: string; readonly message: string; readonly validation: ToolInputValidationFailure | null }
);

export function admitToolCall(input: ToolCallAdmissionInput): ToolCallAdmission {
  const selected = findSelectedTool(input.selection, input.candidate.name, input.candidate.origin);
  const descriptor = selected?.registration.descriptor;
  const base = {
    candidate: deepFreeze({ ...input.candidate }),
    modelCall: input.modelCall,
    selectedTool: descriptor?.ref ?? null,
    inputDigest: createToolContractIdentity("agent-anything.tool-call-input.v1", input.candidate.input),
  };
  const reject = (code: string, message: string, validation: ToolInputValidationFailure | null = null): ToolCallAdmission =>
    deepFreeze({ ...base, status: "rejected" as const, code, message, validation });
  if (descriptor === undefined) return reject("tool_unavailable", "The requested Tool is not selected for this origin.");
  if (input.candidate.revision !== null && input.candidate.revision !== descriptor.ref.revision) {
    return reject("tool_revision_mismatch", "The requested Tool revision is not selected.");
  }
  if (descriptor.retirement !== null) return reject("tool_retired", "The requested Tool revision is retired.");
  if (input.candidate.origin === "model") {
    if (input.candidate.controllerRequestId !== input.modelCall?.controllerRequestId) {
      return reject("tool_call_correlation_invalid", "The Tool attempt does not match its Model Call.");
    }
    if (input.exposure === null || input.exposure.selectionRevision !== input.selection.revision ||
        input.candidate.controllerRequestId !== input.exposure.controllerRequestId ||
        !input.exposure.exposedTools.some((ref) => toolRevisionKey(ref) === toolRevisionKey(descriptor.ref))) {
      return reject("tool_not_exposed", "The requested Tool was not exposed to this Controller request.");
    }
  }
  const validation = validateToolInput({ descriptor, value: input.candidate.input, semanticValidators: input.semanticValidators });
  if (validation.status === "invalid") return reject(validation.failure.code, validation.message, validation.failure);
  return deepFreeze({
    ...base, status: "trusted" as const, binding: descriptor.binding,
    selectionRevision: input.selection.revision,
    exposureProofId: input.candidate.origin === "model" ? input.exposure!.id : null,
  });
}

export function materializeToolCall(input: {
  readonly admission: ToolCallAdmission;
  readonly parentRunAction: RunActionRef;
  readonly toolCallId: string;
  readonly createdAt: string;
}): ToolCallMaterialization {
  const admission = input.admission;
  const attempt = createAttempt({
    ...input, candidate: admission.candidate, modelCall: admission.modelCall,
  }, admission.selectedTool, admission.inputDigest);
  if (admission.status === "rejected") {
    return rejected(attempt, admission.code, admission.message, admission.validation);
  }
  return deepFreeze({
    status: "trusted" as const, attempt,
    call: {
      toolCallId: attempt.ref.id, attempt: attempt.ref,
      parentRunAction: input.parentRunAction, toolRevision: admission.selectedTool!,
      binding: admission.binding, selectionRevision: admission.selectionRevision,
      exposureProofId: admission.exposureProofId, origin: admission.candidate.origin,
      input: admission.candidate.input, inputDigest: admission.inputDigest,
      createdAt: dateTime(input.createdAt),
    },
  });
}

export function validateExactToolCall(call: ToolCall, selection: ToolSelectionRevision): boolean {
  const selected = findSelectedTool(selection, call.toolRevision, call.origin);
  return selected !== undefined && selection.revision === call.selectionRevision &&
    createToolContractIdentity("agent-anything.tool-binding.v1", selected.registration.descriptor.binding) ===
      createToolContractIdentity("agent-anything.tool-binding.v1", call.binding);
}

function createAttempt(
  input: { readonly candidate: ToolCallCandidate; readonly modelCall: ToolCallModelCorrelationRef | null; readonly toolCallId: string; readonly parentRunAction: RunActionRef; readonly createdAt: string },
  selectedTool: ToolRevisionRef | null,
  inputDigest: string,
): ToolCallAttempt {
  if (input.candidate.origin === "model" && input.modelCall === null) {
    throw new TypeError("Model Tool attempts require exact Model Call correlation.");
  }
  return deepFreeze({
    ref: {
      id: token(input.toolCallId),
      runAction: input.parentRunAction,
      modelCall: input.modelCall === null
        ? null
        : Object.freeze({
            id: token(input.modelCall.id),
            controllerRequestId: token(input.modelCall.controllerRequestId),
          }),
    },
    requestedName: token(input.candidate.name),
    requestedRevision: input.candidate.revision,
    selectedTool,
    origin: input.candidate.origin,
    inputDigest,
    createdAt: dateTime(input.createdAt),
  });
}

function rejected(
  attempt: ToolCallAttempt,
  code: string,
  message: string,
  validation: ToolInputValidationFailure | null,
): ToolCallMaterialization {
  return deepFreeze({ status: "rejected" as const, attempt, code, message, validation });
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

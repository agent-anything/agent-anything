import type { OperationDefinitionCatalog, RegisteredOperationDefinition } from "../catalog/index.js";
import { operationDefinitionRevisionKey, snapshotOperationDefinitionRevisionRef, type OperationInvocationRef, type OperationDefinitionRevisionRef } from "../identity/index.js";
import { createOperationResult, type OperationResult } from "./OperationResult.js";

/** Trusted, synchronous validation owned by the capability, including failure output. */
export interface OperationResultContract {
  readonly operation: OperationDefinitionRevisionRef;
  readonly revision: string;
  validateOutput(result: OperationResult): boolean;
}

export interface OperationResultValidation {
  readonly result: OperationResult["ref"];
  readonly contract: { readonly operation: OperationDefinitionRevisionRef; readonly revision: string };
  readonly status: "valid" | "invalid";
  readonly code: "operation_result_output_invalid" | "operation_result_validator_failed" | null;
}

export interface OperationResultContracts {
  readonly catalogId: string;
  readonly catalogRevision: string;
  validate(registration: RegisteredOperationDefinition, invocation: OperationInvocationRef, result: OperationResult): OperationResultValidation;
}

export function createOperationResultContracts(
  catalog: OperationDefinitionCatalog,
  contracts: readonly OperationResultContract[],
): OperationResultContracts {
  const bindings = new Map<string, OperationResultContract>();
  for (const contract of contracts) {
    const operation = snapshotOperationDefinitionRevisionRef(contract.operation);
    const key = operationDefinitionRevisionKey(operation);
    if (bindings.has(key) || typeof contract.revision !== "string" || !contract.revision.trim() ||
        typeof contract.validateOutput !== "function") {
      throw new TypeError("Operation result contract binding is invalid or duplicated.");
    }
    bindings.set(key, Object.freeze({operation, revision: contract.revision, validateOutput: contract.validateOutput.bind(contract)}));
  }
  for (const entry of catalog.entries) {
    const contract = bindings.get(operationDefinitionRevisionKey(entry.operation.ref));
    if (!contract || contract.revision !== entry.operation.resultSchemaRevision) {
      throw new TypeError("Every registered Operation requires its exact result contract revision.");
    }
  }
  if (bindings.size !== catalog.entries.length) throw new TypeError("Result contract does not belong to this Operation catalog.");
  const registrations = new Map(catalog.entries.map(entry => [operationDefinitionRevisionKey(entry.operation.ref), entry]));
  return Object.freeze({
    catalogId: catalog.id,
    catalogRevision: catalog.revision,
    validate(registration: RegisteredOperationDefinition, invocation: OperationInvocationRef, result: OperationResult): OperationResultValidation {
      // Validate the trustworthy envelope independently of untrusted public output.
      createOperationResult({...result, output: result.status === "partial" ? {} : null});
      const key = operationDefinitionRevisionKey(invocation.operation);
      const registered = registrations.get(key);
      const contract = bindings.get(key);
      // Correlation/registration failure is a Harness integrity error, not a Tool output error.
      if (!registered || !contract || operationDefinitionRevisionKey(registration.operation.ref) !== key ||
          registered.binding.ref.revision !== registration.binding.ref.revision ||
          registered.operation.resultSchemaRevision !== registration.operation.resultSchemaRevision ||
          result.ref.invocation.id !== invocation.id || operationDefinitionRevisionKey(result.ref.invocation.operation) !== key ||
          operationDefinitionRevisionKey(result.binding.operation) !== key || result.binding.revision !== registered.binding.ref.revision ||
          result.semanticOwner !== registered.operation.semanticOwner) {
        throw new TypeError("Operation result identity or binding does not match its invocation.");
      }
      let code: OperationResultValidation["code"] = null;
      try {
        if (result.status === "partial" && result.output === null) throw new TypeError("Partial output is missing.");
        assertJsonOutput(result.output);
      } catch {
        code = "operation_result_output_invalid";
      }
      try {
        if (code === null && contract.validateOutput(result) !== true) code = "operation_result_output_invalid";
      } catch {
        code = "operation_result_validator_failed";
      }
      return Object.freeze({result: result.ref,
        contract: Object.freeze({operation: contract.operation, revision: contract.revision}),
        status: code === null ? "valid" : "invalid", code});
    },
  });
}

/** A failed public construction is a new result, never a rewrite or replay of execution. */
export function rejectOperationResultOutput(result: OperationResult, validation: OperationResultValidation): OperationResult {
  if (validation.status !== "invalid" || validation.code === null || validation.result.id !== result.ref.id ||
      validation.result.invocation.id !== result.ref.invocation.id ||
      operationDefinitionRevisionKey(validation.result.invocation.operation) !== operationDefinitionRevisionKey(result.ref.invocation.operation) ||
      operationDefinitionRevisionKey(validation.contract.operation) !== operationDefinitionRevisionKey(result.ref.invocation.operation)) {
    throw new TypeError("An invalid result validation is required.");
  }
  return createOperationResult({
    ...result,
    ref: {invocation: result.ref.invocation, id: `${result.ref.id}:invalid-output`},
    status: result.status === "unknown_effect" || result.status === "cancelled" ? result.status : "failed",
    output: null,
    failure: {owner: "operation-catalog", code: validation.code!,
      message: "Execution returned an invalid public result. Its effects have not been undone; do not repeat the operation solely to obtain its output.",
      retryable: false, metadata: {}},
    lowerRefs: [...result.lowerRefs, {owner: result.semanticOwner, kind: "operation_result", id: result.ref.id, revision: null}],
    metadata: {...result.metadata, resultValidation: validation, executionStatus: result.status},
  });
}

function assertJsonOutput(value: unknown, ancestors = new Set<object>(), depth = 0): void {
  if (value === null || typeof value === "string" || typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))) return;
  if (typeof value !== "object" || depth > 64 || ancestors.has(value)) throw new TypeError("Operation output is not JSON data.");
  const array = Array.isArray(value);
  if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError("Operation output must contain plain data objects.");
  }
  ancestors.add(value);
  try {
    for (const key of Reflect.ownKeys(value)) {
      if (array && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (typeof key !== "string" || !descriptor.enumerable || !Object.hasOwn(descriptor, "value") ||
          (array && !/^(0|[1-9][0-9]*)$/.test(key))) throw new TypeError("Operation output must contain data properties.");
      assertJsonOutput(descriptor.value, ancestors, depth + 1);
    }
    if (array && Object.keys(value).length !== value.length) throw new TypeError("Operation output cannot contain sparse arrays.");
  } finally { ancestors.delete(value); }
}

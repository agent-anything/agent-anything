import { describe, expect, it, vi } from "vitest";
import { createOperationCatalogSnapshot } from "../catalog/index.js";
import { createOperationResult, createOperationResultContracts, rejectOperationResultOutput, type OperationResult } from "./index.js";

const operation = {operation: {namespace: "test", name: "inspect"}, revision: "1"};
const binding = {operation, revision: "1"};
const invocation = {id: "invocation-1", operation};
const time = "2026-10-13T00:00:00.000Z";
const catalog = createOperationCatalogSnapshot({id: "catalog", revision: "1", entries: [{
  admissionId: "admission", operation: {ref: operation, semanticOwner: "test", requestSchemaRevision: "1", resultSchemaRevision: "2",
    roles: {requestOrigins: ["tool_request"], exposure: "eager_tool", runControl: "internal", trust: "effect_free", participation: "semantic_owner", domainPurpose: "test"}},
  binding: {ref: binding, kind: "internal", resolverId: "test", resolverRevision: "1"}, sourceRevision: "1",
  allowedRequestOrigins: ["tool_request"], admittedAt: time, retirement: null,
}]});
const registration = catalog.entries[0]!;
const contract = (validateOutput: (result: OperationResult) => boolean = () => true) => ({operation, revision: "2", validateOutput});
const result = (status: OperationResult["status"] = "succeeded", output: unknown = {value: "ok"}): OperationResult => createOperationResult({
  ref: {id: "result-1", invocation}, binding, semanticOwner: "test", startedAt: time, finishedAt: time,
  lowerRefs: [{owner: "canonical-action", kind: "action_settlement", id: "settlement-1", revision: "1"}],
  metadata: {effectCertainty: "known_applied", completionExtent: "complete"}, status, output,
  failure: status === "succeeded" ? null : {owner: "test", code: "operation_failed", message: "Failure", retryable: false, metadata: {}},
} as OperationResult);

describe("Operation executable result contracts", () => {
  it("requires exact complete registrations before exposure", () => {
    expect(() => createOperationResultContracts(catalog, [])).toThrow(/Every registered/);
    expect(() => createOperationResultContracts(catalog, [{...contract(), revision: "1"}])).toThrow(/exact/);
    expect(() => createOperationResultContracts(catalog, [contract(), contract()])).toThrow(/duplicated/);
  });

  it.each(["succeeded", "partial", "failed", "unavailable", "denied", "cancelled", "timed_out", "invalid", "unknown_effect"] as const)(
    "validates diagnostic output on %s without changing execution", status => {
      const validate = vi.fn(() => true);
      const registry = createOperationResultContracts(catalog, [contract(validate)]);
      const value = result(status);
      expect(registry.validate(registration, invocation, value)).toMatchObject({status: "valid", code: null, contract: {revision: "2"}});
      expect(validate).toHaveBeenCalledWith(value);
      expect(value.status).toBe(status);
    });

  it("treats wrong invocation and binding as integrity failures, not routine output errors", () => {
    const registry = createOperationResultContracts(catalog, [contract()]);
    expect(() => registry.validate(registration, {...invocation, id: "other"}, result())).toThrow(/identity/);
    expect(() => registry.validate(registration, invocation, {...result(), binding: {...binding, revision: "other"}})).toThrow(/binding/);
  });

  it.each([undefined, Number.NaN, new Date(), [undefined], [,,], () => "value"])("rejects non-JSON output without calling its validator", output => {
    const validate = vi.fn(() => true);
    const registry = createOperationResultContracts(catalog, [contract(validate)]);
    const value = {...result(), output} as OperationResult;
    expect(registry.validate(registration, invocation, value)).toMatchObject({status: "invalid", code: "operation_result_output_invalid"});
    expect(validate).not.toHaveBeenCalled();
  });

  it("separates validator exceptions from output rejection", () => {
    expect(createOperationResultContracts(catalog, [contract(() => {throw new Error("secret detail");})])
      .validate(registration, invocation, result())).toMatchObject({code: "operation_result_validator_failed"});
    expect(createOperationResultContracts(catalog, [contract(() => false)])
      .validate(registration, invocation, result())).toMatchObject({code: "operation_result_output_invalid"});
  });

  it.each(["succeeded", "unknown_effect", "cancelled"] as const)("preserves original %s facts when public construction fails", status => {
    const original = result(status);
    const validation = createOperationResultContracts(catalog, [contract(() => false)]).validate(registration, invocation, original);
    const rejected = rejectOperationResultOutput(original, validation);
    expect(original).toMatchObject({status, output: {value: "ok"}});
    expect(rejected).toMatchObject({status: status === "succeeded" ? "failed" : status, output: null,
      metadata: {executionStatus: status, effectCertainty: "known_applied"}, failure: {retryable: false}});
    expect(rejected.ref.id).not.toBe(original.ref.id);
    expect(rejected.lowerRefs).toContainEqual({owner: "test", kind: "operation_result", id: original.ref.id, revision: null});
  });
});

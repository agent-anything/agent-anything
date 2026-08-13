import { describe, expect, it } from "vitest";
import {
  createActionRegistrationSnapshot,
  findActionRegistrationByAdapter,
  findActionRegistrationByBinding,
  type ActionRegistrationInput,
} from "./ActionRegistration.js";

describe("ActionRegistration", () => {
  it("creates one immutable deterministic Operation binding registration", () => {
    const input = registration();
    const snapshot = createActionRegistrationSnapshot([input]);
    const registered = snapshot.registrations[0]!;
    input.adapter.version = "changed";

    expect(snapshot.schemaVersion).toBe(2);
    expect(registered).toMatchObject({
      registrationId: "action-registration.read-file",
      revision: "1",
      operation: OPERATION,
      binding: BINDING,
      adapter: {
        id: "code.read-file.adapter",
        version: "1",
        requestSchemaRevision: "request-1",
      },
      executor: {
        id: "code.read-file.executor",
        version: "1",
        invocationContractVersion: "1",
        physicalPayloadSchemaRevision: "payload-1",
      },
      effectFamilies: ["filesystem"],
    });
    expect(findActionRegistrationByAdapter(snapshot, "code.read-file.adapter"))
      .toBe(registered);
    expect(findActionRegistrationByBinding(snapshot, BINDING)).toBe(registered);
    expect(createActionRegistrationSnapshot([registration()]).snapshotId)
      .toBe(snapshot.snapshotId);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.registrations)).toBe(true);
    expect(Object.isFrozen(registered.operation)).toBe(true);
    expect(Object.isFrozen(registered.adapter)).toBe(true);
    expect(Object.isFrozen(registered.executor)).toBe(true);
    expect(Object.isFrozen(registered.effectFamilies)).toBe(true);
  });

  it("binds every routing, safety, adapter, and executor field into the fingerprint", () => {
    const baseline = registration();
    const fingerprint = fingerprintOf(baseline);
    const changes: ActionRegistrationInput[] = [
      { ...baseline, registrationId: "action-registration.read-other" },
      { ...baseline, revision: "2" },
      {
        ...baseline,
        operation: operation("read-other"),
        binding: binding("read-other"),
      },
      { ...baseline, binding: { ...BINDING, revision: "binding-2" } },
      { ...baseline, adapter: { ...baseline.adapter, id: "other.adapter" } },
      { ...baseline, adapter: { ...baseline.adapter, version: "2" } },
      { ...baseline, adapter: { ...baseline.adapter, requestSchemaRevision: "request-2" } },
      { ...baseline, executor: { ...baseline.executor, id: "other.executor" } },
      { ...baseline, executor: { ...baseline.executor, version: "2" } },
      { ...baseline, executor: { ...baseline.executor, invocationContractVersion: "2" } },
      { ...baseline, executor: { ...baseline.executor, physicalPayloadSchemaRevision: "payload-2" } },
      { ...baseline, effectFamilies: ["network"] },
      { ...baseline, sandboxRequirementRevision: "sandbox-2" },
      { ...baseline, maxInvocationBytes: 2_048 },
      { ...baseline, maxPhysicalResultBytes: 4_096 },
    ];

    for (const changed of changes) expect(fingerprintOf(changed)).not.toBe(fingerprint);
  });

  it("sorts registrations by stable identity and rejects each duplicate owner key", () => {
    const second = registration({
      registrationId: "action-registration.search",
      operation: operation("search"),
      binding: binding("search"),
      adapter: { ...registration().adapter, id: "code.search.adapter" },
    });
    const snapshot = createActionRegistrationSnapshot([second, registration()]);
    expect(snapshot.registrations.map(({ registrationId }) => registrationId)).toEqual([
      "action-registration.read-file",
      "action-registration.search",
    ]);

    expect(() => createActionRegistrationSnapshot([registration(), {
      ...second,
      registrationId: "action-registration.read-file",
    }])).toThrowError(expect.objectContaining({ code: "action_registration_duplicate" }));
    expect(() => createActionRegistrationSnapshot([registration(), {
      ...second,
      operation: OPERATION,
      binding: BINDING,
    }])).toThrowError(expect.objectContaining({ code: "action_operation_duplicate" }));
    expect(() => createActionRegistrationSnapshot([registration(), {
      ...second,
      adapter: registration().adapter,
    }])).toThrowError(expect.objectContaining({ code: "action_adapter_duplicate" }));
  });

  it("rejects incoherent Operation and binding revisions", () => {
    expect(() => createActionRegistrationSnapshot([registration({
      binding: binding("search"),
    })])).toThrowError(expect.objectContaining({ code: "action_operation_mismatch" }));
    expect(() => createActionRegistrationSnapshot([registration({
      effectFamilies: [],
    })])).toThrowError(expect.objectContaining({ code: "action_registration_invalid" }));
    expect(() => createActionRegistrationSnapshot([registration({
      maxInvocationBytes: 0,
    })])).toThrowError(expect.objectContaining({ code: "action_registration_invalid" }));
  });

  it("rejects descriptor accessors, class instances, and unsupported fields", () => {
    const adapter = Object.defineProperties({}, {
      id: { enumerable: true, get: () => "hidden.adapter" },
      version: { enumerable: true, value: "1" },
      requestSchemaRevision: { enumerable: true, value: "request-1" },
    });
    expect(() => createActionRegistrationSnapshot([registration({
      adapter: adapter as never,
    })])).toThrowError(expect.objectContaining({ code: "adapter_descriptor_invalid" }));

    class ExecutorDescriptor {
      id = "executor";
      version = "1";
      invocationContractVersion = "1";
      physicalPayloadSchemaRevision = "payload-1";
    }
    expect(() => createActionRegistrationSnapshot([registration({
      executor: new ExecutorDescriptor(),
    })])).toThrowError(expect.objectContaining({ code: "executor_descriptor_invalid" }));
    expect(() => createActionRegistrationSnapshot([{
      ...registration(),
      execute: () => undefined,
    } as never])).toThrowError(expect.objectContaining({ code: "action_registration_invalid" }));
  });

  it("rejects sparse or accessor-backed registration arrays", () => {
    const sparse: ActionRegistrationInput[] = [];
    sparse.length = 1;
    expect(() => createActionRegistrationSnapshot(sparse)).toThrowError(
      expect.objectContaining({ code: "action_registration_invalid" }),
    );

    const accessor: ActionRegistrationInput[] = [];
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      get: () => registration(),
    });
    accessor.length = 1;
    expect(() => createActionRegistrationSnapshot(accessor)).toThrowError(
      expect.objectContaining({ code: "action_registration_invalid" }),
    );
  });
});

function registration(
  overrides: Partial<ActionRegistrationInput> = {},
): ActionRegistrationInput & {
  adapter: { id: string; version: string; requestSchemaRevision: string };
} {
  return {
    registrationId: "action-registration.read-file",
    revision: "1",
    operation: OPERATION,
    binding: BINDING,
    adapter: {
      id: "code.read-file.adapter",
      version: "1",
      requestSchemaRevision: "request-1",
    },
    executor: {
      id: "code.read-file.executor",
      version: "1",
      invocationContractVersion: "1",
      physicalPayloadSchemaRevision: "payload-1",
    },
    effectFamilies: ["filesystem"],
    sandboxRequirementRevision: "sandbox-1",
    maxInvocationBytes: 1_024,
    maxPhysicalResultBytes: 2_048,
    ...overrides,
  };
}

function fingerprintOf(input: ActionRegistrationInput): string {
  return createActionRegistrationSnapshot([input]).registrations[0]!
    .registrationFingerprint;
}

function operation(name: string) {
  return { operation: { namespace: "code", name }, revision: "1" } as const;
}

function binding(name: string) {
  return { operation: operation(name), revision: "binding-1" } as const;
}

const OPERATION = operation("read-file");
const BINDING = binding("read-file");

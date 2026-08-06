import { describe, expect, it } from "vitest";
import {
  createActionRegistrationSnapshot,
  findActionRegistration,
  type ActionRegistrationInput,
} from "./ActionRegistration.js";

describe("ActionRegistration", () => {
  it("creates an immutable deterministic identity snapshot", () => {
    const input = registration("codeAgent.readFile");
    const snapshot = createActionRegistrationSnapshot([input]);
    const registered = snapshot.registrations[0]!;

    input.adapter.version = "changed";

    expect(registered).toEqual({
      actionName: "codeAgent.readFile",
      adapter: {
        id: "code-agent.file.read.adapter",
        version: "1.0.0",
        inputSchemaVersion: "1",
      },
      executor: {
        id: "code-agent.file.read.executor",
        version: "1.0.0",
        invocationContractVersion: "1",
      },
      registrationFingerprint: createActionRegistrationSnapshot([
        registration("codeAgent.readFile"),
      ]).registrations[0]!.registrationFingerprint,
    });
    expect(findActionRegistration(snapshot, "codeAgent.readFile")).toBe(registered);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.registrations)).toBe(true);
    expect(Object.isFrozen(registered.adapter)).toBe(true);
    expect(Object.isFrozen(registered.executor)).toBe(true);
  });

  it("binds every adapter and executor identity field into the fingerprint", () => {
    const baseline = registration("codeAgent.readFile");
    const fingerprint = createActionRegistrationSnapshot([baseline])
      .registrations[0]!.registrationFingerprint;
    const changes: ActionRegistrationInput[] = [
      registration("codeAgent.readOtherFile"),
      { ...baseline, adapter: { ...baseline.adapter, id: "other.adapter" } },
      { ...baseline, adapter: { ...baseline.adapter, version: "2.0.0" } },
      { ...baseline, adapter: { ...baseline.adapter, inputSchemaVersion: "2" } },
      { ...baseline, executor: { ...baseline.executor, id: "other.executor" } },
      { ...baseline, executor: { ...baseline.executor, version: "2.0.0" } },
      {
        ...baseline,
        executor: { ...baseline.executor, invocationContractVersion: "2" },
      },
    ];

    for (const changed of changes) {
      expect(createActionRegistrationSnapshot([changed]).registrations[0]!.registrationFingerprint)
        .not.toBe(fingerprint);
    }
  });

  it("rejects duplicate and invalid registration identities", () => {
    const input = registration("codeAgent.readFile");
    expect(() => createActionRegistrationSnapshot([input, input])).toThrowError(
      expect.objectContaining({ code: "action_name_duplicate" }),
    );
    expect(() => createActionRegistrationSnapshot([{
      ...input,
      actionName: " codeAgent.readFile",
    }])).toThrowError(expect.objectContaining({ code: "action_name_invalid" }));
    expect(() => createActionRegistrationSnapshot([{
      ...input,
      adapter: { ...input.adapter, version: "" },
    }])).toThrowError(expect.objectContaining({ code: "adapter_descriptor_invalid" }));
    expect(() => createActionRegistrationSnapshot([{
      ...input,
      executor: { ...input.executor, invocationContractVersion: " version 1" },
    }])).toThrowError(expect.objectContaining({ code: "executor_descriptor_invalid" }));
  });

  it("rejects descriptor accessors and class instances", () => {
    const input = registration("codeAgent.readFile");
    const adapter = Object.defineProperty({}, "id", {
      enumerable: true,
      get: () => "hidden.adapter",
    });
    expect(() => createActionRegistrationSnapshot([{
      ...input,
      adapter: adapter as never,
    }])).toThrowError(expect.objectContaining({ code: "adapter_descriptor_invalid" }));

    class ExecutorDescriptor {
      id = "executor";
      version = "1";
      invocationContractVersion = "1";
    }
    expect(() => createActionRegistrationSnapshot([{
      ...input,
      executor: new ExecutorDescriptor(),
    }])).toThrowError(expect.objectContaining({ code: "executor_descriptor_invalid" }));

    expect(() => createActionRegistrationSnapshot([{
      ...input,
      executor: {
        ...input.executor,
        execute: () => undefined,
      } as never,
    }])).toThrowError(expect.objectContaining({ code: "executor_descriptor_invalid" }));
  });

  it("rejects sparse arrays and unknown or accessor registration fields", () => {
    const sparse: ActionRegistrationInput[] = [];
    sparse.length = 1;
    expect(() => createActionRegistrationSnapshot(sparse)).toThrowError(
      expect.objectContaining({ code: "action_registration_invalid" }),
    );

    expect(() => createActionRegistrationSnapshot([{
      ...registration("codeAgent.readFile"),
      execute: () => undefined,
    } as never])).toThrowError(expect.objectContaining({ code: "action_registration_invalid" }));

    const accessor = Object.defineProperty({}, "actionName", {
      enumerable: true,
      get: () => "codeAgent.readFile",
    });
    expect(() => createActionRegistrationSnapshot([accessor as never])).toThrowError(
      expect.objectContaining({ code: "action_registration_invalid" }),
    );
  });
});

function registration(actionName: string): ActionRegistrationInput & {
  adapter: { id: string; version: string; inputSchemaVersion: string };
} {
  return {
    actionName,
    adapter: {
      id: "code-agent.file.read.adapter",
      version: "1.0.0",
      inputSchemaVersion: "1",
    },
    executor: {
      id: "code-agent.file.read.executor",
      version: "1.0.0",
      invocationContractVersion: "1",
    },
  };
}

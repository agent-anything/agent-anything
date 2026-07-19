import { describe, expect, it, vi } from "vitest";
import { createAllowAllActionPolicyPort } from "@agent-anything/governance";
import type { InvocationInterruptionContext } from "@agent-anything/shared";
import type { Action } from "@agent-anything/agent-core/action";
import {
  type ActionAdapter,
  type ActionAdapterPreparedData,
  type ActionAdapterPreparationResult,
  createActionAdapterImplementationSnapshot,
} from "./ActionAdapter.js";
import { ActionEnforcementPipeline } from "./ActionEnforcementPipeline.js";
import {
  createActionRegistrationSnapshot,
  type ActionAdapterDescriptor,
  type ActionExecutorDescriptor,
} from "./ActionRegistration.js";
import type { CanonicalPathIdentityInput } from "./CanonicalIdentity.js";

const SHA_A = `sha256:${"a".repeat(64)}`;
const SHA_B = `sha256:${"b".repeat(64)}`;
const SHA_C = `sha256:${"c".repeat(64)}`;
const NOW = "2026-07-16T00:00:00.000Z";

const adapterDescriptor: ActionAdapterDescriptor = Object.freeze({
  id: "test.file-adapter",
  version: "1.0.0",
  inputSchemaVersion: "1",
});
const executorDescriptor: ActionExecutorDescriptor = Object.freeze({
  id: "test.file-executor",
  version: "1.0.0",
  invocationContractVersion: "1",
});

describe("Action preparation", () => {
  it("creates a deeply immutable prepared Action without retaining raw input", async () => {
    const rawInput = { path: "README.md" };
    const prepare = vi.fn(async () => preparedResult());
    const pipeline = createPipeline({ prepare });

    const result = await pipeline.prepare(createInput({ input: rawInput }));

    expect(result.status).toBe("prepared");
    if (result.status !== "prepared") return;
    expect(prepare).toHaveBeenCalledWith(
      { actionName: "codeAgent.readFile", input: rawInput },
      expect.objectContaining({ environment: expect.objectContaining({ environmentId: "local" }) }),
    );
    expect("input" in result.prepared.action).toBe(false);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.prepared)).toBe(true);
    expect(Object.isFrozen(result.prepared.subject)).toBe(true);
    expect(Object.isFrozen(result.prepared.preparedInvocation.payload)).toBe(true);
    expect(result.prepared.subject.preparedInvocationDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.prepared.actionFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.prepared.subject.targetAssertions.map(({ kind }) => kind)).toEqual([
      "adapter_registration",
      "environment_identity",
      "executor_registration",
      "file_baseline",
    ]);
  });

  it("produces the same fingerprint for equal canonical subjects", async () => {
    const first = await prepared(createPipeline(), createInput());
    const second = await prepared(
      createPipeline({ now: () => "2026-07-16T01:00:00.000Z" }),
      createInput({ input: { alternateModelShape: true } }),
    );

    expect(first.actionFingerprint).toBe(second.actionFingerprint);
    expect(first.subject.preparedInvocationDigest).toBe(second.subject.preparedInvocationDigest);
    expect(first.preparedAt).not.toBe(second.preparedAt);
  });

  it("keeps safe display changes outside canonical identity", async () => {
    const first = await prepared(createPipeline(), createInput());
    const second = await prepared(createPipeline({
      data: createPreparedData({
        safeSummary: {
          kind: "file_system",
          headline: "Read a source document",
          operations: [{ operation: "read", sourceLabel: "source document", destinationLabel: null }],
        },
      }),
    }), createInput());

    expect(first.safeSummary).not.toEqual(second.safeSummary);
    expect(first.actionFingerprint).toBe(second.actionFingerprint);
  });

  it.each([
    ["invocation payload", { payload: { path: "README-2.md" } }],
    ["secret reference", { secretReferences: ["credential:test"] }],
  ])("changes the fingerprint when the %s changes", async (_label, invocation) => {
    const baseline = await prepared(createPipeline(), createInput());
    const changed = await prepared(createPipeline({
      data: createPreparedData({
        preparedInvocation: {
          contractVersion: "1",
          executorId: executorDescriptor.id,
          executorVersion: executorDescriptor.version,
          payload: { path: "README.md" },
          ...invocation,
        },
      }),
    }), createInput());

    expect(changed.subject.preparedInvocationDigest)
      .not.toBe(baseline.subject.preparedInvocationDigest);
    expect(changed.actionFingerprint).not.toBe(baseline.actionFingerprint);
  });

  it("changes the fingerprint when operation, authority, identity, or registration changes", async () => {
    const baseline = await prepared(createPipeline(), createInput());
    const operation = await prepared(createPipeline({
      data: createPreparedData({
        operation: {
          kind: "file_system",
          operations: [{ sequence: 0, operation: "read", target: target(SHA_A) }],
          parametersDigest: SHA_B,
        },
        effectSet: {
          kind: "effects",
          values: [{ kind: "file_system", operation: "read", targets: [target(SHA_A)] }],
        },
      }),
    }), createInput());
    const authority = await prepared(createPipeline({
      data: createPreparedData({
        requestedPermissions: { fileSystem: { read: ["D:/outside"] } },
      }),
    }), createInput());
    const identity = await prepared(createPipeline(), createInput({
      actor: { identityId: "user-2", kind: "user" },
    }));
    const workspaceTrust = await prepared(createPipeline(), createInput({
      workspaceTrustState: "restricted",
    }));
    const registration = await prepared(createPipeline({
      adapter: { ...adapterDescriptor, version: "2.0.0" },
    }), createInput());

    for (const changed of [operation, authority, identity, workspaceTrust, registration]) {
      expect(changed.actionFingerprint).not.toBe(baseline.actionFingerprint);
    }
  });

  it("rejects missing primary effects and conflicting canonical target identities", async () => {
    const missingEffect = await createPipeline({
      data: createPreparedData({ effectSet: { kind: "effect_free" } }),
    }).prepare(createInput());
    const conflictingEffect = await createPipeline({
      data: createPreparedData({
        effectSet: {
          kind: "effects",
          values: [{ kind: "file_system", operation: "read", targets: [target(SHA_B)] }],
        },
      }),
    }).prepare(createInput());

    for (const result of [missingEffect, conflictingEffect]) {
      expect(result).toEqual(expect.objectContaining({
        status: "failed",
        error: expect.objectContaining({ code: "tool_action_adapter_contract_invalid" }),
      }));
    }
  });

  it("binds approval category and authority-applicability keys into the subject", async () => {
    const first = await prepared(createPipeline({
      data: createPreparedData({
        approvalCategory: "permissions",
        approvalPayload: permissionPayload(),
        applicabilityKeys: [{ category: "permissions", value: "path:workspace/README.md" }],
      }),
    }), createInput());
    const second = await prepared(createPipeline({
      data: createPreparedData({
        approvalCategory: "permissions",
        approvalPayload: permissionPayload(),
        applicabilityKeys: [{ category: "permissions", value: "path:workspace" }],
      }),
    }), createInput());

    expect(first.subject.approvalContext).toEqual({
      category: "permissions",
      applicabilityKeys: [{ category: "permissions", value: "path:workspace/README.md" }],
    });
    expect(second.actionFingerprint).not.toBe(first.actionFingerprint);
  });

  it("returns closed rejected, failed, and interrupted outcomes", async () => {
    const unknown = await createPipeline().prepare(createInput({
      action: action({ name: "codeAgent.unknown" }),
    }));
    const rejectedResult = await createPipeline({
      result: { status: "rejected", code: "action_invalid", message: "Path is required." },
    }).prepare(createInput());
    const failedResult = await createPipeline({
      result: { status: "failed", code: "tool_resolver_failed", message: "Resolution failed.", retryable: true },
    }).prepare(createInput());
    const interruptedResult = await createPipeline({
      result: {
        status: "interrupted",
        interruption: {
          kind: "operation_deadline",
          deadline: { operationId: "prepare-1", deadlineAt: NOW },
        },
      },
    }).prepare(createInput());

    expect(unknown).toEqual(expect.objectContaining({ status: "rejected", code: "tool_not_found" }));
    expect(rejectedResult).toEqual({ status: "rejected", code: "action_invalid", message: "Path is required." });
    expect(failedResult).toEqual({
      status: "failed",
      error: {
        owner: "tool",
        code: "tool_resolver_failed",
        message: "Resolution failed.",
        retryable: true,
        metadata: {},
      },
    });
    expect(interruptedResult).toEqual({
      status: "interrupted",
      interruption: {
        kind: "operation_deadline",
        deadline: { operationId: "prepare-1", deadlineAt: NOW },
      },
    });
  });

  it("fails closed for adapter exceptions and malformed trusted output", async () => {
    const thrown = await createPipeline({
      prepare: async () => { throw new Error("sensitive detail"); },
    }).prepare(createInput());
    const malformed = await createPipeline({
      data: createPreparedData({
        effectSet: {
          kind: "effects",
          values: [{ kind: "future_effect" } as never],
        },
      }),
    }).prepare(createInput());
    const mismatch = await createPipeline({
      data: createPreparedData({
        preparedInvocation: {
          contractVersion: "1",
          executorId: "test.other-executor",
          executorVersion: "1.0.0",
          payload: {},
        },
      }),
    }).prepare(createInput());
    const missingApprovalPayload = await createPipeline({
      data: createPreparedData({
        approvalCategory: "permissions",
        approvalPayload: null,
      }),
    }).prepare(createInput());

    expect(thrown).toEqual(expect.objectContaining({
      status: "failed",
      error: expect.objectContaining({ code: "tool_action_adapter_failed" }),
    }));
    for (const result of [malformed, mismatch, missingApprovalPayload]) {
      expect(result).toEqual(expect.objectContaining({
        status: "failed",
        error: expect.objectContaining({ code: "tool_action_adapter_contract_invalid" }),
      }));
    }
  });

  it("interrupts before invoking an adapter when cancellation is already attributed", async () => {
    const abort = new AbortController();
    abort.abort();
    const prepare = vi.fn(async () => preparedResult());
    const result = await createPipeline({ prepare }).prepare(createInput({
      interruption: {
        signal: abort.signal,
        interruption: {
          kind: "run_cancellation",
          cancellation: { runId: "run-1", requestId: "cancel-1" },
        },
      },
    }));

    expect(result.status).toBe("interrupted");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("fails closed instead of throwing when an aborted preparation has no attribution", async () => {
    const abort = new AbortController();
    abort.abort();
    const prepare = vi.fn(async () => preparedResult());
    const result = await createPipeline({ prepare }).prepare(createInput({
      interruption: { signal: abort.signal, interruption: null },
    }));

    expect(result).toEqual(expect.objectContaining({
      status: "failed",
      error: expect.objectContaining({ code: "tool_action_interruption_unattributed" }),
    }));
    expect(prepare).not.toHaveBeenCalled();
  });

  it("requires an exact one-to-one implementation snapshot", () => {
    const registrations = createRegistrations();
    const adapter = createAdapter();

    expect(() => createActionAdapterImplementationSnapshot(registrations, []))
      .toThrow("Missing Action adapter implementation");
    expect(() => createActionAdapterImplementationSnapshot(registrations, [
      { actionName: "codeAgent.readFile", adapter },
      { actionName: "codeAgent.readFile", adapter },
    ])).toThrow("Duplicate Action adapter implementation");
    expect(() => createActionAdapterImplementationSnapshot(registrations, [{
      actionName: "codeAgent.other",
      adapter,
    }])).toThrow("Unregistered Action adapter implementation");
    expect(() => createActionAdapterImplementationSnapshot(registrations, [{
      actionName: "codeAgent.readFile",
      adapter: createAdapter({ ...adapterDescriptor, version: "9.0.0" }),
    }])).toThrow("does not match registration");
  });
});

interface PipelineOverrides {
  readonly adapter?: ActionAdapterDescriptor;
  readonly executor?: ActionExecutorDescriptor;
  readonly data?: ActionAdapterPreparedData;
  readonly result?: ActionAdapterPreparationResult;
  readonly prepare?: ActionAdapter["prepare"];
  readonly now?: () => string;
}

function createPipeline(overrides: PipelineOverrides = {}): ActionEnforcementPipeline {
  const adapter = overrides.adapter ?? adapterDescriptor;
  const executor = overrides.executor ?? executorDescriptor;
  const registrations = createRegistrations(adapter, executor);
  return new ActionEnforcementPipeline({
    registrations,
    adapters: [{
      actionName: "codeAgent.readFile",
      adapter: createAdapter(
        adapter,
        overrides.prepare ?? (async () => overrides.result ?? preparedResult(overrides.data)),
      ),
    }],
    policyPort: createAllowAllActionPolicyPort(),
    now: overrides.now ?? (() => NOW),
  });
}

function createRegistrations(
  adapter: ActionAdapterDescriptor = adapterDescriptor,
  executor: ActionExecutorDescriptor = executorDescriptor,
) {
  return createActionRegistrationSnapshot([{
    actionName: "codeAgent.readFile",
    adapter,
    executor,
  }]);
}

function createAdapter(
  descriptor: ActionAdapterDescriptor = adapterDescriptor,
  prepare: ActionAdapter["prepare"] = async () => preparedResult(),
): ActionAdapter {
  return {
    descriptor,
    prepare,
    async revalidate() {
      return { status: "valid" };
    },
  };
}

function preparedResult(data = createPreparedData()): ActionAdapterPreparationResult {
  return { status: "prepared", data };
}

function createPreparedData(
  overrides: Partial<ActionAdapterPreparedData> = {},
): ActionAdapterPreparedData {
  const path = target();
  return {
    operation: {
      kind: "file_system",
      operations: [{ sequence: 0, operation: "read", target: path }],
      parametersDigest: SHA_A,
    },
    effectSet: {
      kind: "effects",
      values: [{ kind: "file_system", operation: "read", targets: [path] }],
    },
    requestedPermissions: null,
    targetAssertions: [{
      kind: "file_baseline",
      path,
      expected: {
        kind: "present",
        entryKind: "file",
        objectIdentity: { kind: "win32", volumeId: "volume-1", fileId: "file-1" },
        contentDigest: SHA_C,
      },
    }],
    approvalCategory: null,
    approvalPayload: null,
    applicabilityKeys: [],
    safeSummary: {
      kind: "file_system",
      headline: "Read README.md",
      operations: [{ operation: "read", sourceLabel: "README.md", destinationLabel: null }],
    },
    preparedInvocation: {
      contractVersion: "1",
      executorId: executorDescriptor.id,
      executorVersion: executorDescriptor.version,
      payload: { path: "README.md" },
    },
    ...overrides,
  };
}

function target(resolutionFingerprint = SHA_A): CanonicalPathIdentityInput {
  return {
    platform: "win32",
    path: "D:/workspace/README.md",
    resolvedPath: "D:/workspace/README.md",
    workspaceRootId: "root-1",
    resolutionFingerprint,
  };
}

function permissionPayload() {
  return {
    permissions: { fileSystem: { read: ["D:/workspace/README.md"] } },
    cwd: "D:/workspace",
    cwdDisplay: "workspace",
    environmentId: "local",
  } as const;
}

interface InputOverrides {
  readonly input?: unknown;
  readonly action?: Action;
  readonly actor?: { readonly identityId: string; readonly kind: "user" | "service" | "anonymous" };
  readonly workspaceTrustState?: "trusted" | "restricted" | "unknown";
  readonly interruption?: InvocationInterruptionContext;
}

function createInput(overrides: InputOverrides = {}) {
  const abort = new AbortController();
  return {
    action: overrides.action ?? action({ input: overrides.input ?? { path: "README.md" } }),
    workspace: {
      workspaceId: "workspace-1",
      trustState: overrides.workspaceTrustState ?? "trusted" as const,
      roots: [{
        rootId: "root-1",
        platform: "win32" as const,
        path: "D:/workspace",
        resolvedPath: "D:/workspace",
        resolutionFingerprint: SHA_B,
      }],
    },
    actor: overrides.actor ?? { identityId: "user-1", kind: "user" as const },
    environment: {
      environmentId: "local",
      platform: "win32" as const,
      configurationFingerprint: SHA_C,
    },
    interruption: overrides.interruption ?? { signal: abort.signal, interruption: null },
  };
}

function action(overrides: Partial<Action> = {}): Action {
  return {
    id: "action-1",
    runId: "run-1",
    sequence: 1,
    kind: "tool",
    name: "codeAgent.readFile",
    input: { path: "README.md" },
    provenance: { modelItemId: "model-item-1", controllerIteration: 1 },
    ...overrides,
  };
}

async function prepared(
  pipeline: ActionEnforcementPipeline,
  input: ReturnType<typeof createInput>,
) {
  const result = await pipeline.prepare(input);
  expect(result.status).toBe("prepared");
  if (result.status !== "prepared") throw new Error("Expected prepared Action.");
  return result.prepared;
}

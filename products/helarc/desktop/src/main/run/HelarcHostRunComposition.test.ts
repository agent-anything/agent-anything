import {
  createStaticHostIdentityResolver,
  createStaticHostWorkspaceResolver,
  type HostIdentityResolver,
  type HostIdentitySelection,
  type HostWorkspaceResolver,
  type HostWorkspaceSelection,
} from "@agent-anything/host/context";
import type { ApprovalReviewInput } from "@agent-anything/permission";
import type {
  Provider,
  ProviderCallResult,
  ProviderRequest,
} from "@agent-anything/model-interaction";
import {
  createModelCallRef,
  createModelTurnId,
  snapshotModelCallableRequest,
  snapshotProviderResponse,
  type ModelJsonValue,
} from "@agent-anything/model-interaction";
import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import { createFakeProviderContext } from "@agent-anything/test-support";
import type { WorkspaceSelection } from "@agent-anything/workspace/selection";
import { access, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { join, relative, resolve, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { createHelarcTask } from "@agent-anything/helarc/task";
import { createHelarcProviderProfile } from "@agent-anything/helarc/configuration";
import { createDefaultHelarcInstructionSettings } from "@agent-anything/helarc/configuration";
import { HelarcInspection } from "../inspection/HelarcInspection.js";
import { InspectionQueryService } from "@agent-anything/inspection/query";
import { workbenchInteractionText } from "../workbench/WorkbenchInteractionPresentation.js";
import { isWorkbenchOperation } from "../workbench/WorkbenchOperationPresentation.js";
import { CommandOutputRegistry } from "../workbench/CommandOutputRegistry.js";
import { HelarcExecutionStore } from "../execution-storage/HelarcExecutionStore.js";
import {openExecutionStoreFixture as openUnmanagedExecutionStoreFixture} from "../execution-storage/fixtures/ExecutionEnvironmentFixture.js";
import {ExecutionFixtureScope} from "./fixtures/ExecutionFixtureScope.js";
import {withExecutionScope} from "./fixtures/ManagedExecutionTest.js";
import { pathToFileURL } from "node:url";
import {
  prepareHelarcHostRun,
  type HelarcHostActiveRun,
  type PrepareHelarcHostRunInput,
} from "./HelarcHostRunComposition.js";

type RunHelarcTestInput = Omit<
  PrepareHelarcHostRunInput,
  | "sessionId"
  | "productRunId"
  | "permissionPreset"
  | "inputItems"
  | "workspaceResolver"
  | "workspaceSelection"
  | "identityResolver"
  | "identitySelection"
  | "providerProfile"
  | "commandOutputDirectory"
> & {
  readonly commandOutputDirectory?: string;
  readonly workspace: WorkspaceSelection;
  readonly workspaceResolver?: HostWorkspaceResolver;
  readonly workspaceSelection?: HostWorkspaceSelection;
  readonly identityResolver?: HostIdentityResolver;
  readonly identitySelection?: HostIdentitySelection;
  readonly sessionId?: string;
  readonly productRunId?: string;
  readonly enableShell?: boolean;
  readonly permissionPreset?: PrepareHelarcHostRunInput["permissionPreset"];
  readonly inputItems?: PrepareHelarcHostRunInput["inputItems"];
  readonly providerProfile?: PrepareHelarcHostRunInput["providerProfile"];
};

async function executeTestHostRun(input: RunHelarcTestInput) {
  const prepared = await prepareTestHostRun(input);
  const composition = prepared.start();
  return composition.result;
}

function openExecutionStoreFixture(...args: Parameters<typeof openUnmanagedExecutionStoreFixture>) {
  const create = () => openUnmanagedExecutionStoreFixture(...args);
  return ExecutionFixtureScope.current()?.open(create) ?? create();
}

const commandOutputDirectory = mkdtempSync(join(tmpdir(), "helarc-host-output-"));
afterAll(() => rm(commandOutputDirectory, { recursive: true, force: true }));

async function prepareTestHostRun(input: RunHelarcTestInput) {
  const productRunId = input.productRunId ?? input.sessionId ?? input.task.id;
  const permissionPreset = input.permissionPreset ?? "ask_for_approval";
  const {
    workspace,
    workspaceResolver,
    workspaceSelection,
    identityResolver,
    identitySelection,
    enableShell,
    inputItems,
    providerProfile,
    ...hostInput
  } = input;
  const create = () => prepareHelarcHostRun({
    ...hostInput,
    commandOutputDirectory: input.commandOutputDirectory ?? commandOutputDirectory,
    workspaceResolver: workspaceResolver ??
      createStaticHostWorkspaceResolver(workspace),
    workspaceSelection: workspaceSelection ?? {
      kind: "references",
      primaryRef: workspace.primary.id,
      additionalRefs: workspace.additional.map((candidate) => candidate.id),
    },
    identityResolver: identityResolver ?? createStaticHostIdentityResolver({
      id: "test-anonymous",
      kind: "anonymous",
      displayName: "Test user",
      metadata: {},
    }),
    identitySelection: identitySelection ?? { kind: "anonymous" },
    productRunId,
    sessionId: input.sessionId ?? productRunId,
    inputItems: inputItems ?? [],
    permissionPreset,
    providerProfile: providerProfile ?? createTestProviderProfile(input.provider),
  });
  return ExecutionFixtureScope.current()?.prepare(create) ?? create();
}

function createTestProviderProfile(
  provider: Provider,
): PrepareHelarcHostRunInput["providerProfile"] {
  const result = createHelarcProviderProfile({
    id: "test-provider",
    providerKind: provider.descriptor.id === "ollama.api"
      ? "ollama"
      : "openai-compatible",
    displayName: "Test Provider",
    baseUrl: "https://provider.local/v1",
    model: provider.modelContext.target.model,
    timeoutMs: 30_000,
    credentialStatus: "empty_allowed",
    isActive: true,
  });
  if (!result.ok) throw new TypeError("Test Provider profile is invalid.");
  return result.profile;
}

function executeReadOnlyTestHostRun(
  input: Omit<RunHelarcTestInput, "enableShell">,
) {
  return executeTestHostRun({ ...input, enableShell: false });
}

describe("Helarc Host Run composition", () => {
  it("reconstructs admission before the first command without adopting the new Host environment", withExecutionScope(async () => {
    const directory = await mkdtemp(join(tmpdir(), "helarc-admission-recovery-"));
    const workspaceRoot = join(directory, "workspace"); await mkdir(workspaceRoot);
    const worker = pathToFileURL(join(process.cwd(), "dist/main/execution-storage/ExecutionStoreWorker.js"));
    const store = await openExecutionStoreFixture(join(directory, "execution"), worker);
    const original = process.env.HELARC_TEST_NEW_HOST_VARIABLE;
    try {
      const provider = new ScriptedProvider([]);
      const common = {...createTask(workspaceRoot), provider, executionStore: store};
      const first = await prepareTestHostRun(common);
      const saved = (await store.readProductRun(first.rootRunId))!;
      expect(await store.readProcesses(first.rootRunId)).toEqual([]);
      process.env.HELARC_TEST_NEW_HOST_VARIABLE = "different-after-restart";
      const restored = await prepareTestHostRun({...common, recoveryAdmission: saved,
        instructionSettings: saved.instructionSettings, providerProfile: saved.providerProfile});
      expect(restored.rootRunId).toBe(first.rootRunId);
      expect(provider.requests).toEqual([]);
      expect(store.restoreCommandEnvironment(saved.commandEnvironment).environment.HELARC_TEST_NEW_HOST_VARIABLE).toBe(original);
      const otherRoot = join(directory, "other"); await mkdir(otherRoot);
      await expect(prepareTestHostRun({...common, ...createTask(otherRoot), recoveryAdmission: saved,
        instructionSettings: saved.instructionSettings, providerProfile: saved.providerProfile})).rejects.toThrow("command_shell_dependency_changed");
      await expect(prepareTestHostRun({...common, recoveryAdmission: {...saved, providerBinding: {...saved.providerBinding,
        descriptor: {...saved.providerBinding.descriptor, id: "different-provider"}}}})).rejects.toThrow("provider");
      expect(provider.requests).toEqual([]);
    } finally {
      if (original === undefined) delete process.env.HELARC_TEST_NEW_HOST_VARIABLE;
      else process.env.HELARC_TEST_NEW_HOST_VARIABLE = original;
      await store.close();
      if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith("helarc-admission-recovery-")) throw new Error("Unexpected test path");
      await rm(directory, {recursive: true, force: true});
    }
  }), 20_000);
  it("recovers a committed compensation association after lost acknowledgement before dispatch", withExecutionScope(async () => {
    const directory = await mkdtemp(join(tmpdir(), "helarc-compensation-recovery-"));
    const workspaceRoot = join(directory, "workspace"); await mkdir(workspaceRoot);
    const worker = pathToFileURL(join(process.cwd(), "dist/main/execution-storage/ExecutionStoreWorker.js"));
    let store = await openExecutionStoreFixture(join(directory, "execution"), worker);
    try {
      const commit = store.commitCompensationAssociation.bind(store);
      let retained: import("@agent-anything/operation-catalog/evidence").CompensationAssociation | null = null;
      store.commitCompensationAssociation = async association => {
        await commit(association);
        retained = association;
        throw new Error("Lost compensation acknowledgement");
      };
      const provider = new ScriptedProvider([
        {kind: "tool_call", toolName: "Write", input: {file_path: "target.txt", content: "before"}},
        (request: ProviderRequest) => {
          const settlement = request.messages.flatMap(message => message.role === "tool" ? message.content.map(block => block.result) : []).at(-1)!;
          const content = settlement.content as {references: readonly ModelJsonValue[]};
          return {kind: "tool_call", toolName: "Write", input: {file_path: "target.txt", content: "after",
            compensation_of: {targets: [content.references[0]!]}}};
        },
      ]);
      const prepared = await prepareTestHostRun({...createTask(workspaceRoot), provider, executionStore: store, permissionPreset: "full_access"});
      await expect(prepared.start().result).rejects.toBeDefined();
      expect(retained).not.toBeNull();
      expect(provider.requests).toHaveLength(2);
      await expect(readFile(join(workspaceRoot, "target.txt"), "utf8")).resolves.toBe("before");
      const saved = (await store.readProductRun(prepared.rootRunId))!;
      await store.close();
      store = await openExecutionStoreFixture(join(directory, "execution"), worker);
      const nextProvider = new ScriptedProvider([{kind: "completion", summary: "The retained call settled."}]);
      const recovered = await prepareTestHostRun({...createTask(workspaceRoot), provider: nextProvider,
        providerProfile: saved.providerProfile, instructionSettings: saved.instructionSettings,
        executionStore: store, recoveryAdmission: saved, permissionPreset: "full_access"});
      const result = await (await recovered.recover("continue")).result;
      expect(result.runResult.status, JSON.stringify(result.runResult.cause)).toBe("completed");
      expect(nextProvider.requests).toHaveLength(1);
      await expect(readFile(join(workspaceRoot, "target.txt"), "utf8")).resolves.toBe("after");
      const association = retained as unknown as import("@agent-anything/operation-catalog/evidence").CompensationAssociation;
      expect(await store.readCompensationAssociation(association.invocation.id)).toEqual(association);
      expect(operationResults(result).filter(operation => operation.ref.invocation.id === association.invocation.id)).toHaveLength(1);
    } finally {
      await store.close();
      const target = resolve(directory);
      if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("helarc-compensation-recovery-")) throw new Error("Unexpected test directory.");
      await rm(target, {recursive: true, force: true});
    }
  }), 60_000);
  it("delivers an execution locator and accepts model-declared compensation through ordinary governed file work", withExecutionScope(async () => {
    const directory = await mkdtemp(join(tmpdir(), "helarc-compensation-binding-"));
    const workspaceRoot = join(directory, "workspace"); await mkdir(workspaceRoot);
    const worker = pathToFileURL(join(process.cwd(), "dist/main/execution-storage/ExecutionStoreWorker.js"));
    const observed: import("@agent-anything/operation-catalog/evidence").ExecutionEvidenceObservation[] = [];
    let store = await openExecutionStoreFixture(join(directory, "execution"), worker, {observe(value) {observed.push(value);}});
    try {
      let original: import("@agent-anything/model-interaction").ModelJsonValue = null;
      const provider = new ScriptedProvider([
        {kind: "tool_call", toolName: "Write", input: {file_path: "target.txt", content: "before"}},
        (request: ProviderRequest) => {
          const settlements = request.messages.flatMap(message => message.role === "tool" ? message.content.map(block => block.result) : []);
          const content = settlements.at(-1)!.content as {references: readonly import("@agent-anything/model-interaction").ModelJsonValue[]};
          original = content.references.find(reference => reference !== null && typeof reference === "object" &&
            !Array.isArray(reference) && "kind" in reference && reference.kind === "effect")!;
          expect(original).toBeDefined();
          return {kind: "tool_call", toolName: "Write", input: {file_path: "target.txt", content: "must not be written",
            compensation_of: {targets: [{...(original as object), id: "unknown"}]}}};
        },
        (request: ProviderRequest) => {
          const settlements = request.messages.flatMap(message => message.role === "tool" ? message.content.map(block => block.result) : []);
          expect(settlements.at(-1)).toMatchObject({settlement: "invalid", content: {
            failure: {code: "execution_reference_unavailable"}}});
          return {kind: "tool_call", toolName: "Edit", input: {file_path: "target.txt", old_string: "before", new_string: "after",
            compensation_of: {targets: [original], explanation: "Replace the original content"}}};
        },
        {kind: "completion", summary: "The explicitly associated edit settled."},
      ]);
      const prepared = await prepareTestHostRun({...createTask(workspaceRoot), provider, executionStore: store,
        permissionPreset: "full_access", instructionSettings: createDefaultHelarcInstructionSettings()});
      const result = await prepared.start().result;
      expect(result.runResult.status, JSON.stringify(result.product.output.safeErrors)).toBe("completed");
      expect(provider.requests.every(request => request.instructions.content.length === 0)).toBe(true);
      const operations = operationResults(result);
      expect(operations.map(operation => operation.status)).toEqual(["succeeded", "invalid", "succeeded"]);
      expect(operations[1]?.metadata).toMatchObject({effectCertainty: "none", completionExtent: "none"});
      expect(result.product.actions).toHaveLength(2);
      await expect(readFile(join(workspaceRoot, "target.txt"), "utf8")).resolves.toBe("after");
      const invocation = operations.at(-1)!.ref.invocation;
      const association = await store.readCompensationAssociation(invocation.id);
      expect(association).toMatchObject({invocation, targets: [{requested: original,
        execution: {kind: "execution", id: operations[0]!.ref.id}}],
        explanation: "Replace the original content"});
      const evidence = await store.readExecutionEvidence(association!.targets[0]!.requested);
      expect(evidence?.effects[0]).toMatchObject({ref: original, value: {operation: "created", before: null}});
      expect(observed.filter(event => event.kind === "compensation_intent_committed")).toHaveLength(1);
      const physical = await store.readRunTree(prepared.rootRunId);
      const savedBindings = physical!.members.flatMap(member => member.head.control.operations.map(preparation => preparation.binding));
      expect(savedBindings.some(binding => binding.compensation?.id === association?.id)).toBe(true);
      expect(savedBindings.every(binding => !Object.hasOwn(binding.request as object, "compensation_of"))).toBe(true);
      await store.close();
      store = await openExecutionStoreFixture(join(directory, "execution"), worker);
      expect(await store.readCompensationAssociation(invocation.id)).toEqual(association);
    } finally {
      await store.close();
      const target = resolve(directory);
      if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("helarc-compensation-binding-")) throw new Error("Unexpected test directory.");
      await rm(target, {recursive: true, force: true});
    }
  }), 45_000);
  it.each([false, true])("retains, queries and restores file content/existence through governed Tools (created=%s)", withExecutionScope(async created => {
    const directory = await mkdtemp(join(tmpdir(), "helarc-file-support-"));
    const workspaceRoot = join(directory, "workspace"); await mkdir(workspaceRoot);
    if (!created) await writeFile(join(workspaceRoot, "target.txt"), "original bytes");
    const worker = pathToFileURL(join(process.cwd(), "dist/main/execution-storage/ExecutionStoreWorker.js"));
    let store = await openExecutionStoreFixture(join(directory, "execution"), worker);
    try {
      let change: ModelJsonValue = null;
      let material: ModelJsonValue = null;
      const provider = new ScriptedProvider([
        {kind: "tool_call", toolName: "Write", input: {file_path: "target.txt", content: "changed bytes"}},
        (request: ProviderRequest) => {
          const content = request.messages.flatMap(message => message.role === "tool" ? message.content.map(block => block.result) : []).at(-1)!.content as {references: ModelJsonValue[]};
          change = content.references.find(ref => (ref as {kind?: string})?.kind === "effect")!;
          material = content.references.find(ref => (ref as {kind?: string})?.kind === "material")!;
          expect(material).toBeDefined();
          return {kind: "tool_call", toolName: "ExecutionDetails", input: {reference: material, view: "content"}};
        },
        (request: ProviderRequest) => {
          const latest = request.messages.flatMap(message => message.role === "tool" ? message.content.map(block => block.result) : []).at(-1)!;
          expect(latest.settlement, JSON.stringify(latest)).toBe("succeeded");
          expect(JSON.stringify(latest)).toContain(created ? "absence" : "original bytes");
          return {kind: "tool_call", toolName: "RestoreFile", input: {change_ref: change}};
        },
        {kind: "completion", summary: "Restoration requested."},
      ]);
      const prepared = await prepareTestHostRun({...createTask(workspaceRoot), provider, executionStore: store,
        permissionPreset: "full_access", instructionSettings: createDefaultHelarcInstructionSettings()});
      const result = await prepared.start().result;
      const operations = operationResults(result);
      expect(operations.map(value => value.status), JSON.stringify(operations)).toEqual(["succeeded", "succeeded", "succeeded"]);
      expect(result.runResult.status).toBe("completed");
      expect(result.product.actions).toHaveLength(2);
      if (created) await expect(access(join(workspaceRoot, "target.txt"))).rejects.toThrow();
      else await expect(readFile(join(workspaceRoot, "target.txt"), "utf8")).resolves.toBe("original bytes");
      expect(await store.readCompensationAssociation(operations[2]!.ref.invocation.id)).toMatchObject({targets: [{requested: change}]});
      const restoredEvidence = await store.readExecutionEvidence({owner: operations[2]!.semanticOwner, kind: "execution", id: operations[2]!.ref.id, revision: "1"});
      expect(restoredEvidence?.effects[0]?.value).toMatchObject({operation: created ? "removed" : "restored"});
      expect((await store.readFileMaterialRecord(material as never))?.pins).toContain(prepared.rootRunId);
      if (created) {
        vi.spyOn(store, "finalizeFileMaterials").mockRejectedValueOnce(new Error("interrupted material finalization"));
        await expect(store.commitProductDelivery(prepared.rootRunId)).rejects.toThrow("interrupted material finalization");
        expect(await store.listProductRuns()).toContainEqual(expect.objectContaining({delivered: true, terminal: true}));
        expect((await store.readFileMaterialRecord(material as never))?.pins).toContain(prepared.rootRunId);
      } else {
        await store.commitProductDelivery(prepared.rootRunId);
        expect(await store.readFileMaterialRecord(material as never)).toMatchObject({state: "available", pins: []});
      }
      await store.close(); store = await openExecutionStoreFixture(join(directory, "execution"), worker);
      expect(await store.readExecutionEvidence(material as never)).not.toBeNull();
      const released = await store.readFileMaterialRecord(material as never);
      expect(released).toMatchObject({state: "available", pins: []});
      await store.finalizeFileMaterials(prepared.rootRunId);
      expect((await store.readFileMaterialRecord(material as never))?.expiresAt).toBe(released!.expiresAt);
      await store.expireFileMaterials("2100-01-01T00:00:00.000Z");
      expect(await store.readFileMaterialRecord(material as never)).toMatchObject({state: "expired", reason: "retention_expired"});
    } finally {
      await store.close();
      const target = resolve(directory);
      if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("helarc-file-support-")) throw new Error("Unexpected test directory.");
      await rm(target, {recursive: true, force: true});
    }
  }), 60_000);
  it("hands Child execution references to Parent for a normally governed restoration", withExecutionScope(async () => {
    const directory = await mkdtemp(join(tmpdir(), "helarc-child-compensation-"));
    const workspaceRoot = join(directory, "workspace"); await mkdir(workspaceRoot);
    await writeFile(join(workspaceRoot, "target.txt"), "original bytes");
    const worker = pathToFileURL(join(process.cwd(), "dist/main/execution-storage/ExecutionStoreWorker.js"));
    let store = await openExecutionStoreFixture(join(directory, "execution"), worker);
    try {
      let childExecution: ModelJsonValue = null;
      const provider = new ScriptedProvider([
        {kind: "tool_call", toolName: "Agent", input: {prompt: "Change target.txt."}},
        {kind: "tool_call", toolName: "Write", input: {file_path: "target.txt", content: "child bytes"}},
        {kind: "completion", summary: "Changed the file."},
        (request: ProviderRequest) => {
          const content = request.messages.flatMap(message => message.role === "tool" ? message.content.map(block => block.result.content) : []).at(-1) as {output: {execution_refs: ModelJsonValue[]}};
          childExecution = content.output.execution_refs[0]!;
          expect(childExecution).toBeDefined();
          return {kind: "tool_call", toolName: "ExecutionDetails", input: {reference: childExecution}};
        },
        (request: ProviderRequest) => {
          const content = request.messages.flatMap(message => message.role === "tool" ? message.content.map(block => block.result.content) : []).at(-1) as {output: {entries: {ref: ModelJsonValue}[]; callable_support: {callable_name: string}[]}};
          expect(content.output.callable_support[0]!.callable_name).toMatch(/^RestoreFile_/);
          return {kind: "tool_call", toolName: "RestoreFile", input: {change_ref: content.output.entries[0]!.ref}};
        },
        {kind: "completion", summary: "Restored Child change."},
      ]);
      const prepared = await prepareTestHostRun({...createTask(workspaceRoot), provider, executionStore: store,
        permissionPreset: "full_access", instructionSettings: createDefaultHelarcInstructionSettings()});
      const result = await prepared.start().result;
      expect(result.runResult.status).toBe("completed");
      await expect(readFile(join(workspaceRoot, "target.txt"), "utf8")).resolves.toBe("original bytes");
      const transfers = await store.readExecutionReferenceTransfers(prepared.rootRunId);
      expect(transfers).toEqual([expect.objectContaining({scope: {kind: "public_run"}, basis: expect.objectContaining({kind: "delegation_result"})})]);
      await store.close(); store = await openExecutionStoreFixture(join(directory, "execution"), worker);
      expect(await store.readExecutionReferenceTransfers(prepared.rootRunId)).toEqual(transfers);
      expect(await store.readExecutionEvidence(childExecution as never)).not.toBeNull();
    } finally {
      await store.close();
      const target = resolve(directory);
      if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("helarc-child-compensation-")) throw new Error("Unexpected test directory.");
      await rm(target, {recursive: true, force: true});
    }
  }), 90_000);
  it("recovers a completed restoration after lost Attempt acknowledgement without repeating its mutation", withExecutionScope(async () => {
    const directory = await mkdtemp(join(tmpdir(), "helarc-restore-recovery-"));
    const workspaceRoot = join(directory, "workspace"); await mkdir(workspaceRoot);
    await writeFile(join(workspaceRoot, "target.txt"), "original bytes");
    const worker = pathToFileURL(join(process.cwd(), "dist/main/execution-storage/ExecutionStoreWorker.js"));
    let store = await openExecutionStoreFixture(join(directory, "execution"), worker);
    try {
      let restoreAction: string | null = null;
      const preparation = store.recordPreEffect.bind(store), attempt = store.recordAttemptResult.bind(store);
      store.recordPreEffect = async value => {
        if (value.binding.binding.operation.operation.namespace === "helarc.code-agent.file" && value.binding.binding.operation.operation.name === "restore") restoreAction = value.prepared.subject.ref.action.id;
        return preparation(value);
      };
      let lost = false;
      store.recordAttemptResult = async value => {
        const receipt = await attempt(value);
        if (!lost && value.result.attempt.action.id === restoreAction) {lost = true; throw new Error("Lost restoration outcome acknowledgement");}
        return receipt;
      };
      const provider = new ScriptedProvider([
        {kind: "tool_call", toolName: "Write", input: {file_path: "target.txt", content: "changed bytes"}},
        (request: ProviderRequest) => {
          const content = request.messages.flatMap(message => message.role === "tool" ? message.content.map(block => block.result.content) : []).at(-1) as {references: ModelJsonValue[]};
          return {kind: "tool_call", toolName: "RestoreFile", input: {change_ref: content.references.find(ref => (ref as {kind: string}).kind === "effect")!}};
        },
      ]);
      const prepared = await prepareTestHostRun({...createTask(workspaceRoot), provider, executionStore: store, permissionPreset: "full_access"});
      await expect(prepared.start().result).rejects.toBeDefined();
      expect(lost).toBe(true);
      expect(await readFile(join(workspaceRoot, "target.txt"), "utf8")).toBe("original bytes");
      const saved = (await store.readProductRun(prepared.rootRunId))!;
      await store.close(); store = await openExecutionStoreFixture(join(directory, "execution"), worker);
      const next = new ScriptedProvider([{kind: "completion", summary: "Restored."}]);
      const recovered = await prepareTestHostRun({...createTask(workspaceRoot), provider: next, executionStore: store,
        providerProfile: saved.providerProfile, instructionSettings: saved.instructionSettings, recoveryAdmission: saved, permissionPreset: "full_access"});
      const result = await (await recovered.recover("continue")).result;
      expect(result.runResult.status).toBe("completed");
      expect(next.requests).toHaveLength(1);
      const records = await store.readAction({runId: prepared.rootRunId, action: {id: restoreAction!}});
      expect(records.attempts).toHaveLength(1);
      expect(records.settlement?.settlement.status).toBe("succeeded");
      expect(await readFile(join(workspaceRoot, "target.txt"), "utf8")).toBe("original bytes");
    } finally {
      await store.close();
      const target = resolve(directory);
      if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("helarc-restore-recovery-")) throw new Error("Unexpected test directory.");
      await rm(target, {recursive: true, force: true});
    }
  }), 90_000);
  it.each(["continue", "cancel"] as const)("restores an accepted Turn after lost acknowledgement and %s without recreating the decision", withExecutionScope(async (intent: "continue" | "cancel") => {
    const directory = await mkdtemp(join(tmpdir(), "helarc-host-recovery-"));
    const workspaceRoot = join(directory, "workspace"); await mkdir(workspaceRoot);
    await writeFile(join(workspaceRoot, "input.txt"), "retained input", "utf8");
    const worker = pathToFileURL(join(process.cwd(), "dist/main/execution-storage/ExecutionStoreWorker.js"));
    let store = await openExecutionStoreFixture(join(directory, "execution"), worker);
    try {
      const provider = new ScriptedProvider([{kind: "tool_call", toolName: "Read", input: {file_path: "input.txt"}}]);
      const prepare = await prepareTestHostRun({...createTask(workspaceRoot), provider, executionStore: store});
      const commit = store.commitRunTree.bind(store);
      let interrupted = false;
      store.commitRunTree = async value => {
        const receipt = await commit(value);
        if (!interrupted && value.runs.some(run => run.control.decision?.status === "active")) {
          interrupted = true;
          throw new Error("Lost acknowledgement after accepted decision");
        }
        return receipt;
      };
      await expect(prepare.start().result).rejects.toBeDefined();
      expect(interrupted).toBe(true);
      expect(provider.requests).toHaveLength(1);
      const saved = (await store.readProductRun(prepare.rootRunId))!;
      const before = await store.readRunTree(prepare.rootRunId);
      expect(before?.members[0]?.head.control.decision?.status).toBe("active");
      await store.close();
      store = await openExecutionStoreFixture(join(directory, "execution"), worker);
      const nextProvider = new ScriptedProvider([{kind: "completion", summary: "Read complete."}]);
      const recovered = await prepareTestHostRun({...createTask(workspaceRoot), provider: nextProvider,
        providerProfile: saved.providerProfile, instructionSettings: saved.instructionSettings, executionStore: store, recoveryAdmission: saved});
      const outcome = await (await recovered.recover(intent)).result;
      expect(outcome.harnessRunId).toBe(prepare.rootRunId);
      expect(outcome.runResult.status, JSON.stringify(outcome.runResult.cause)).toBe(intent === "cancel" ? "cancelled" : "completed");
      expect(nextProvider.requests).toHaveLength(intent === "cancel" ? 0 : 1);
      if (intent === "continue") {
        expect(JSON.stringify(nextProvider.requests[0]?.messages)).toContain("retained input");
        const observations = outcome.runResult.items.flatMap(item => item.payload.kind === "observation" &&
          item.payload.observation.payload.kind === "operation" ? [item.payload.observation.payload.result] : []);
        expect(observations).toHaveLength(1);
        const result = observations[0]!;
        expect(await store.readExecutionEvidence({owner: result.semanticOwner, kind: "execution", id: result.ref.id, revision: "1"}))
          .toMatchObject({source: {result: result.ref, correlation: {kind: "run_action", run: {id: prepare.rootRunId}}},
            outcome: {status: "succeeded"}, effects: [], support: []});
      }
      expect((await store.listProductRuns())[0]).toMatchObject({terminal: true, delivered: false});
      await store.commitProductDelivery(prepare.rootRunId);
      expect((await store.listProductRuns())[0]?.delivered).toBe(true);
    } finally {await store.close(); await rm(directory, {recursive: true, force: true});}
  }), 45_000);
  it("records the real Tool, Context and lifecycle path without optional instructions or execution interference", withExecutionScope(async () => {
    const directory = await mkdtemp(join(tmpdir(), "helarc-inspection-run-"));
    const workspaceRoot = join(directory, "workspace"); await mkdir(workspaceRoot);
    await writeFile(join(workspaceRoot, "input.txt"), "existing work", "utf8");
    const inspection = await HelarcInspection.create(join(directory, "settings.json"), join(directory, "inspection"));
    const queries = new InspectionQueryService(join(directory, "inspection"));
    const defaults = createDefaultHelarcInstructionSettings();
    const instructionSettings = {
      agent: defaults.agent.map((entry) => ({ ...entry, enabled: false })),
      delegated: defaults.delegated.map((entry) => ({ ...entry, enabled: false })),
      protocol: defaults.protocol.map((entry) => ({ ...entry, enabled: false })),
      stop: defaults.stop.map((entry) => ({ ...entry, enabled: false })),
    };
    const run = async (observed: boolean) => {
      const provider = new ScriptedProvider(
        [{ kind: "tool_call", toolName: "Glob", input: { pattern: "**/*", path: "." } }, { kind: "completion", summary: "Inspected." }],
        (request) => {
          if (!observed) return;
          inspection.providerObserver!.observe({
            attemptId: `${request.requestId}:attempt:1`, requestId: request.requestId,
            runId: typeof request.metadata.runId === "string" ? request.metadata.runId : null,
            controllerRequestId: request.correlation.controllerRequestId,
            providerId: provider.descriptor.id, model: "host-run-test-model",
            occurredAt: "2026-06-28T00:00:00.000Z", stage: "request", status: "prepared",
            endpoint: null, httpStatus: null, encodedBytes: null, code: null,
            request, result: null, body: null, representation: "semantic", contentUnavailable: false,
          });
        },
      );
      const result = await executeReadOnlyTestHostRun({ ...createTask(workspaceRoot), provider, instructionSettings, inspection: observed ? inspection : undefined, now: () => "2026-06-28T00:00:00.000Z" });
      return { result, provider };
    };
    try {
      const baseline = await run(false); const recorded = await run(true);
      expect(recorded.result.runResult.status).toBe(baseline.result.runResult.status);
      expect(recorded.result.activity.map((event) => event.kind)).toEqual(baseline.result.activity.map((event) => event.kind));
      expect(recorded.provider.requests.length).toBe(baseline.provider.requests.length);
      expect(recorded.provider.requests[0]?.instructions.content).toEqual([]);
      expect(recorded.provider.stopRequests).toHaveLength(0);
      expect(await readFile(join(workspaceRoot, "input.txt"), "utf8")).toBe("existing work");
      await inspection.recorder!.flush();
      // Durable capture competes with other real-filesystem suites; this is not a latency assertion.
      await expect.poll(() => inspection.recorder!.health().queued, { timeout: 45_000 }).toBe(0);
      expect(inspection.snapshot().health).toMatchObject({ available: true, rejected: 0, dropped: 0, code: null });
      const scope = (await queries.query({ kind: "get_snapshot", sourceId: inspection.recorder!.source.sourceId, datasetId: inspection.recorder!.manifest.datasetId })).selection!;
      const definitions = (await queries.query({ ...scope, kind: "list_definitions", limit: 500 })).records;
      expect(definitions.some((record) => record.payload.kind === "definition" && record.payload.definitionKind === "tool")).toBe(true);
      const runs = (await queries.query({ ...scope, kind: "list_runs" })).records;
      expect(runs[0]?.payload).toMatchObject({ status: "completed" });
      expect((await queries.query({ ...scope, kind: "get_lifecycle", subject: runs[0]!.subject })).records.some((record) => record.payload.kind === "transition" && record.payload.to === "completed")).toBe(true);
      const execution = await queries.query({...scope,kind:"get_execution_flow",runId:recorded.result.runResult.runId,limit:500});
      expect(execution.records.flatMap(record=>record.payload.kind === "flow_invocation" ? [record.payload.observation.definition.id] : [])).toEqual(expect.arrayContaining([
        "run-execution", "model-call-execution", "model-turn", "model-context-admission", "result-delivery",
      ]));
      const core = execution.records.find(record => record.payload.kind === "flow_invocation" && record.payload.observation.definition.id === "run-execution")!;
      const coreScope = {...scope, runId: recorded.result.runResult.runId, invocationId: core.subject.id};
      const occurrences = (await queries.query({...coreScope, kind: "list_flow_occurrences", limit: 500})).records;
      for (const record of occurrences) {
        const detail = await queries.query({...coreScope, kind: "get_flow_occurrence", occurrenceId: record.subject.id});
        expect(detail.flow?.occurrence?.status).toBe("closed");
        expect(detail.flow?.occurrence?.checks.every(check => check.availability === "recorded")).toBe(true);
        expect(detail.flow?.occurrence?.references.every(reference => reference.availability === "present" || reference.availability === "observed_later"), JSON.stringify({step:record.payload,refs:detail.flow?.occurrence?.references})).toBe(true);
        if (record.payload.kind === "flow_step" && ["initialize", "controller", "decision", "admission", "dispatch", "join"].includes(record.payload.observation.stepId)) {
          expect(detail.flow?.occurrence?.references.some(reference => reference.role === "input")).toBe(true);
        }
        if (record.payload.kind === "flow_step" && record.payload.observation.stepId === "controller") {
          expect(detail.flow?.occurrence?.references.find(reference => reference.role === "output")?.contents[0]?.availability).toBe("present");
        }
      }
      const supportingFlows = new Set(["agent-stop-dispatch", "model-turn", "model-input-composition", "model-context-admission", "model-response-interpretation", "retry-execution", "result-delivery"]);
      for (const invocation of execution.records.filter(record => record.payload.kind === "flow_invocation" && supportingFlows.has(record.payload.observation.definition.id))) {
        const invocationScope = {...scope, runId: recorded.result.runResult.runId, invocationId: invocation.subject.id};
        const steps = (await queries.query({...invocationScope, kind: "list_flow_occurrences", limit: 500})).records;
        let inputs = 0; let outputs = 0;
        for (const step of steps) {
          const detail = await queries.query({...invocationScope, kind: "get_flow_occurrence", occurrenceId: step.subject.id});
          const occurrence = detail.flow!.occurrence!;
          expect(occurrence.status).toBe("closed");
          expect(occurrence.checks.every(check => check.availability === "recorded"), JSON.stringify(occurrence.checks)).toBe(true);
          expect(occurrence.references.every(ref => ["present", "observed_later"].includes(ref.availability)), JSON.stringify(occurrence.references)).toBe(true);
          inputs += occurrence.references.filter(ref => ref.role === "input").length;
          outputs += occurrence.references.filter(ref => ref.role === "output" && ref.contents.some(content => content.availability === "present")).length;
        }
        expect(inputs, invocation.subject.id).toBeGreaterThan(0);
        expect(outputs, invocation.subject.id).toBeGreaterThan(0);
      }
      const material = (await queries.query({...scope, kind: "list_records", recordKind: "event", limit: 500})).records;
      for (const name of ["Run input", "Run configuration", "Bound execution background", "controller.decision", "operation.request", "operation.binding", "operation.result"]) {
        expect(material.find(record => record.payload.kind === "event" && record.payload.name === name)?.contents[0]?.availability, name).toBe("present");
      }
      const nativeRefs = execution.records.flatMap((record) => record.links.flatMap((link) => [link.from, link.to]))
        .filter((ref) => ref.kind === "request" || ref.kind === "operation");
      expect(nativeRefs.map((ref) => ref.kind)).toEqual(expect.arrayContaining(["request", "operation"]));
      const uniqueRefs = new Map(nativeRefs.map((ref) => [JSON.stringify(ref), ref]));
      for (const subject of uniqueRefs.values()) {
        const source = await queries.query({ ...scope, kind: "get_subject", subject });
        expect(source.records.some((record) => record.subject.owner === subject.owner &&
          record.subject.id === subject.id && record.subject.kind === subject.kind &&
          record.subject.revision === subject.revision), `Missing native source: ${JSON.stringify(subject)}`).toBe(true);
      }
      const flow = (await queries.query({ ...scope, kind: "get_data_flow" })).graph!;
      expect(flow.links.some((link) => link.targetLocation?.stage === "semantic" && link.targetLocation.jsonPointer?.startsWith("/messages/"))).toBe(true);
      expect((await queries.query({ ...scope, kind: "get_scheduling", subject: runs[0]!.subject })).records.length).toBeGreaterThan(0);
    } finally {
      await queries.close(); await inspection.close();
      if (!relative(tmpdir(), directory).startsWith("helarc-inspection-run-")) throw new Error("Invalid test cleanup target");
      await rm(directory, { recursive: true });
    }
  }), 90_000);
  it("binds instruction settings before asynchronous preparation and allows a Run with no system instructions", withExecutionScope(async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-no-instructions-"));
    const provider = new ScriptedProvider([{ kind: "completion", summary: "Completed." }]);
    const defaults = createDefaultHelarcInstructionSettings();
    const settings = {
      agent: defaults.agent.map((entry) => ({ ...entry, enabled: false })),
      delegated: defaults.delegated.map((entry) => ({ ...entry, enabled: false })),
      protocol: defaults.protocol.map((entry) => ({ ...entry, enabled: false })),
      stop: defaults.stop.map((entry) => ({ ...entry, enabled: false })),
    };
    const preparing = prepareTestHostRun({ ...createTask(workspaceRoot), provider, instructionSettings: settings });
    settings.agent[0]!.enabled = true;
    settings.protocol[0]!.enabled = true;
    settings.stop[0]!.enabled = true;
    const prepared = await preparing;
    const result = await prepared.start().result;
    expect(result.runResult.status).toBe("completed");
    expect(provider.requests[0]?.instructions.content).toEqual([]);
    expect(provider.requests[0]?.interaction).toMatchObject({ kind: "native_tool_turn" });
    expect(provider.stopRequests).toHaveLength(0);
  }));
  it("passes custom Stop text through Host and Product composition without adding it to the main loop", withExecutionScope(async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-stop-instructions-"));
    const provider = new ScriptedProvider([{ kind: "completion", summary: "Completed." }]);
    const defaults = createDefaultHelarcInstructionSettings();
    const instructionSettings = { ...defaults, stop: [{ ...defaults.stop[0]!, enabled: true, content: "Check only the supplied completion evidence." }] };
    await executeTestHostRun({ ...createTask(workspaceRoot), provider, instructionSettings });
    expect(provider.stopRequests).toHaveLength(1);
    expect(provider.stopRequests[0]?.composition.workingView.recipientRunId).toBe(provider.requests[0]?.composition.workingView.recipientRunId);
    expect(provider.stopRequests[0]?.instructions.content).toEqual([
      { kind: "text", text: "Check only the supplied completion evidence." },
    ]);
    expect(JSON.stringify(provider.requests[0]?.instructions)).not.toContain("Check only the supplied completion evidence.");
  }));
  it("prepares without invoking Runner and permits exactly one start", withExecutionScope(async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-prepared-run-"));
    const provider = new ScriptedProvider([{ kind: "completion", summary: "Prepared." }]);
    const prepared = await prepareTestHostRun({
      ...createTask(workspaceRoot),
      provider,
      instructionSettings: createDefaultHelarcInstructionSettings(),
    });

    expect(provider.requests).toHaveLength(0);
    const composition = prepared.start();
    expect(() => prepared.start()).toThrow("only once");
    await expect(composition.result).resolves.toMatchObject({
      kind: "run_result",
      product: { status: "completed" },
    });
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.instructions.content).toEqual([]);
    expect(provider.stopRequests).toHaveLength(0);
  }));

  it("keeps the complete Run deadline separate from one Provider request window", withExecutionScope(async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-run-deadline-"));
    const startedAt = Date.parse("2026-08-20T00:00:00.000Z");
    let elapsedMs = 0;
    const provider = new ScriptedProvider(
      [{ kind: "completion", summary: "Completed after a long model request." }],
      () => {
        elapsedMs = 31_000;
      },
    );

    const result = await executeReadOnlyTestHostRun({
      ...createTask(workspaceRoot),
      provider,
      now: () => new Date(startedAt + elapsedMs).toISOString(),
    });

    expect(result.runResult).toMatchObject({ status: "completed" });
    expect(result.product).toMatchObject({ status: "completed" });
  }));

  it("fails Host Workspace acquisition before a Runner can start", withExecutionScope(async () => {
    const provider = new ScriptedProvider([
      { kind: "completion", summary: "Must not run." },
    ]);

    await expect(prepareTestHostRun({
      ...createTask("D:/missing-workspace"),
      provider,
      workspaceResolver: {
        async resolve() {
          throw new Error("Workspace unavailable.");
        },
      },
    })).rejects.toMatchObject({
      code: "host_workspace_resolution_failed",
    });
    expect(provider.requests).toHaveLength(0);
  }));

  it("runs one read-only tool call and completes with ordered activity", withExecutionScope(async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-session-"));
    await mkdir(join(workspaceRoot, "src"));
    await writeFile(join(workspaceRoot, "src", "index.ts"), "export const value = 1;\n");

    const provider = new ScriptedProvider([
      {
        kind: "tool_call",
        reason: "Inspect workspace files.",
        toolName: "Glob",
        input: { pattern: "**/*", path: "." },
      },
      {
        kind: "completion",
        summary: "Workspace contains src/index.ts. No changes needed.",
      },
    ]);

    const result = await executeReadOnlyTestHostRun({
      ...createTask(workspaceRoot),
      provider,
      now: () => "2026-06-28T00:00:00.000Z",
    });

    expect(result.product.status).toBe("completed");
    expect(result.runResult.status).toBe("completed");
    expect(result.product.output).toMatchObject({
      agentSummary: "Workspace contains src/index.ts. No changes needed.",
      runtimeStatus: "completed",
      safeErrors: [],
    });
    expect(result.activity.map((item) => item.kind)).toEqual([
      "run.started",
      "context.transition.committed",
      "context.transition.committed",
      "context.projection.completed",
      "controller.started",
      "run.item.appended",
      "controller.tool_exposure.resolved",
      "controller.finished",
      "run.item.appended",
      "operation.started",
      "operation.finished",
      "context.transition.committed",
      "run.item.appended",
      "run.item.appended",
      "context.transition.committed",
      "context.projection.completed",
      "controller.started",
      "run.item.appended",
      "controller.tool_exposure.resolved",
      "controller.finished",
      "context.transition.committed",
      "run.item.appended",
      "run.item.appended",
      "run.item.appended",
      "run.item.appended",
      "run.completed",
    ]);
    const modelCallSettlement = result.activity.find(
      (item) => item.kind === "run.item.appended" &&
        item.metadata.itemKind === "model_call_settlement",
    );
    expect(modelCallSettlement).toBeDefined();
    const contextProjection = result.activity.find(
      (item) => item.kind === "context.projection.completed",
    );
    expect(contextProjection?.metadata).toMatchObject({
      outcome: "projected",
      accountingUnit: "bytes",
    });
    expect(contextProjection?.metadata).not.toHaveProperty("records");
    expect(provider.requests).toHaveLength(2);
    expect(provider.lastControllerResultCounts).toEqual([0, 1]);
    expect(result.activity.find((item) => item.kind === "controller.finished")?.metadata).toMatchObject({
      promptArchitectureVersion: "helarc-prompt-v10",
      toolExposureVersion: "trusted-tool-exposure-v1",
    });
    expect(result.activity.find((item) => item.kind === "controller.finished")?.metadata)
      .not.toHaveProperty("actionContractVersion");
    expect(provider.requests[1]?.messages).toContainEqual(expect.objectContaining({
      role: "tool",
      content: [expect.objectContaining({
        kind: "model_tool_result",
        result: expect.objectContaining({ settlement: "succeeded" }),
      })],
    }));
  }));

  it("asks one correlated clarification and resumes the same Run", withExecutionScope(async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-clarification-"));
    const provider = new ScriptedProvider([
      {
        kind: "tool_call",
        toolName: "AskUserQuestion",
        input: {
          questions: [{
            id: "scope",
            prompt: "Which package should be inspected?",
            options: [{
              label: "Runtime",
              description: "Inspect the runtime package.",
            }],
            allow_multiple: false,
          }],
        },
      },
      { kind: "completion", summary: "Clarification received." },
    ]);
    const prepared = await prepareTestHostRun({
      ...createTask(workspaceRoot),
      provider,
    });
    const composition = prepared.start();
    await waitUntil(() => composition.activeRun.getStatus().pendingInteractions.length === 1);
    const pending = composition.activeRun.getStatus().pendingInteractions[0]!;

    expect(pending.presentation).toMatchObject({
      questions: [{ id: "scope", prompt: "Which package should be inspected?" }],
    });
    const pendingQuestion = composition.activeRun.getProductProjection().presentation.activeCalls.find(record =>
      record.content.kind === "tool_call" && record.content.toolBindingKind === "interaction");
    expect(pendingQuestion?.content).toMatchObject({ callableKind: "tool", interactionProtocol: {
      owner: "helarc", kind: "clarification", revision: "1",
    } });
    expect(pendingQuestion && isWorkbenchOperation(pendingQuestion)).toBe(false);
    expect((await composition.activeRun.submitInteraction({
      request: pending.request,
      submissionId: "clarification-submission-1",
      payload: {
        answers: [{
          question_id: "scope",
          selected_labels: ["Runtime"],
          text: null,
        }],
      },
    })).status).toBe("accepted_for_resolution");

    const result = await composition.result;
    expect(result.runResult.status).toBe("completed");
    expect(result.product.interactions).toEqual([
      expect.objectContaining({ owner: "helarc", status: "resolved" }),
    ]);
    const product = composition.activeRun.getProductProjection();
    const exchange = product.presentation.records.find(record => record.id === pendingQuestion?.id)!;
    expect(workbenchInteractionText(exchange, { product, host: composition.activeRun.getProjection() })).toMatchObject({
      title: "Question", status: "Answered", text: expect.stringContaining("Which package should be inspected?\nYour answer:\nRuntime"),
    });
    expect(result.runResult.items).toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({
        kind: "observation",
        observation: expect.objectContaining({
          payload: expect.objectContaining({
            kind: "interaction",
            toolResult: expect.objectContaining({ status: "succeeded" }),
          }),
        }),
      }),
    }));
    expect(provider.requests).toHaveLength(2);
  }));

  it("delegates one Agent Tool call to an isolated descendant Run", withExecutionScope(async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-descendant-"));
    const provider = new ScriptedProvider([
      {
        kind: "tool_call",
        toolName: "Agent",
        input: {
          prompt: "Inspect the runtime contracts.",
          description: "Contract inspection",
        },
      },
      { kind: "completion", summary: "Child inspection complete." },
      { kind: "completion", summary: "Parent received the child result." },
    ]);

    const result = await executeTestHostRun({
      ...createTask(workspaceRoot),
      provider,
    });

    expect(result.runResult.status).toBe("completed");
    expect(result.product.children).toEqual([
      expect.objectContaining({ owner: "agent-runtime", status: "succeeded" }),
    ]);
    expect(result.runResult.items).toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({
        kind: "observation",
        observation: expect.objectContaining({
          payload: expect.objectContaining({
            kind: "descendant_run",
            status: "succeeded",
            toolResult: expect.objectContaining({ status: "succeeded" }),
          }),
        }),
      }),
    }));
    expect(operationResults(result)).toEqual([]);
    expect(provider.requests).toHaveLength(3);
  }));

  it("preserves whitespace-bearing Agent prompts through nested delegation", withExecutionScope(async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-delegation-text-"));
    const childPrompt = "\r\n Inspect and delegate the detail.\n  ";
    const nestedPrompt = "\tInspect this example:\n    return 1;\r\n";
    const provider = new ScriptedProvider([
      { kind: "tool_call", toolName: "Agent", input: { prompt: childPrompt, description: " Inspection\n" } },
      { kind: "tool_call", toolName: "Agent", input: { prompt: nestedPrompt } },
      { kind: "completion", summary: "Nested inspection complete." },
      { kind: "completion", summary: "Child inspection complete." },
      { kind: "completion", summary: "Parent received the child result." },
    ]);
    const result = await executeTestHostRun({ ...createTask(workspaceRoot), provider });
    expect(result.runResult.status).toBe("completed");
    expect(provider.requests).toHaveLength(5);
    expect(findTextBlock(provider.requests[1]!, "Parent assignment:")).toBe(`Parent assignment:\n${childPrompt}`);
    expect(findTextBlock(provider.requests[2]!, "Parent assignment:")).toBe(`Parent assignment:\n${nestedPrompt}`);
    expect(operationResults(result)).toEqual([]);
  }));

  it("accepts a whitespace-bearing SendMessage prompt for a settled Child", withExecutionScope(async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-continuation-text-"));
    const message = "\r\n  Explain the second finding.\n\t";
    const provider = new ScriptedProvider([
      { kind: "tool_call", toolName: "Agent", input: { prompt: "Inspect and report." } },
      { kind: "completion", summary: "Child findings." },
      (request: ProviderRequest) => {
        const results = request.messages.flatMap(message => message.role === "tool" ? message.content.map(block => block.result.content) : []);
        const delegation = results.find(value => value && typeof value === "object" && "kind" in value && value.kind === "descendant_run") as {output: {agent_id: string}};
        return {
          kind: "tool_call",
          toolName: "SendMessage",
          input: { agent_id: delegation.output.agent_id, prompt: message },
        };
      },
      { kind: "completion", summary: "Second finding explained." },
      { kind: "completion", summary: "Parent received the explanation." },
    ]);
    const result = await executeTestHostRun({ ...createTask(workspaceRoot), provider });
    expect(result.runResult.status).toBe("completed");
    expect(provider.requests).toHaveLength(5);
    expect(provider.requests[3]?.messages).toContainEqual(expect.objectContaining({
      role: "user",
      content: expect.arrayContaining([expect.objectContaining({ kind: "text", text: `Parent assignment:\n${message}` })]),
    }));
    expect(operationResults(result)).toEqual([]);
  }));

  it.each([true, false])("delivers a Child's final text with limitations to the Parent (report: %s)", withExecutionScope(async (hasReport) => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-child-report-"));
    const report = "SDK inspection findings.\n\nBuild and run commands.";
    const finalText = `${hasReport ? `${report}\n\n` : ""}No further work is available.`;
    const provider = new ScriptedProvider([
      { kind: "tool_call", toolName: "Agent", input: { prompt: "Inspect and report." } },
      {
        kind: "plan_update",
        plan: [{ step: "Inspect and report", status: "completed" }],
        assistantTexts: hasReport ? ["SDK inspection findings.", "Build and run commands."] : [],
      },
      { kind: "completion", summary: finalText, plan: [{ step: "Inspect and report", status: "completed" }] },
      { kind: "completion", summary: "Parent received the Child result." },
    ]);
    const result = await executeTestHostRun({ ...createTask(workspaceRoot), provider });
    expect(result.runResult.status).toBe("completed");
    const expectedOutput = {
      status: "completed",
      summary: finalText,
      failure_code: null,
    };
    expect(result.runResult.items).toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({
        kind: "observation",
        observation: expect.objectContaining({
          payload: expect.objectContaining({
            kind: "descendant_run",
            status: "succeeded",
            toolResult: expect.objectContaining({
              status: "succeeded",
              output: expect.objectContaining(expectedOutput),
            }),
          }),
        }),
      }),
    }));
    expect(provider.requests).toHaveLength(4);
    expect(provider.requests[3]?.messages).toContainEqual(expect.objectContaining({
      role: "tool",
      content: expect.arrayContaining([expect.objectContaining({
        kind: "model_tool_result",
        result: expect.objectContaining({
          settlement: "succeeded",
          content: expect.objectContaining({
            kind: "descendant_run",
            output: expect.objectContaining(expectedOutput),
          }),
        }),
      })]),
    }));
    expect(operationResults(result)).toEqual([]);
  }));

  it("projects Provider request retry history through Runner activity", withExecutionScope(async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-provider-retry-"));
    const provider = new RetryThenCompleteProvider();

    const prepared = await prepareTestHostRun({
      ...createTask(workspaceRoot),
      provider,
      now: () => "2026-07-14T00:00:00.000Z",
    });
    const composition = prepared.start();
    const result = await composition.result;

    expect(result.product.status, JSON.stringify({cause:result.runResult.cause, events:result.activity.filter(item=>item.kind.startsWith("retry") || item.kind.startsWith("controller"))})).toBe("completed");
    expect(provider.requests).toHaveLength(2);
    const retryProjection = composition.activeRun.getStatus().retry;
    expect(retryProjection).not.toBeNull();
    const retryActivity = retryProjection?.recentEvents.filter((item) =>
      item.owner === "provider_request"
    );
    expect(retryActivity?.map((item) => item.event)).toEqual([
      "retry_attempt_started",
      "retry_attempt_finished",
      "retry_scheduled",
      "retry_attempt_started",
      "retry_attempt_finished",
    ]);
    expect(new Set(retryActivity?.map((item) => item.operationId))).toEqual(
      new Set([`${provider.requests[0]!.correlation.controllerRequestId}:provider-request:1`]),
    );
    expect(retryActivity?.find((item) => item.event === "retry_scheduled")).toMatchObject({
      owner: "provider_request",
      attemptNumber: 2,
      delayMs: 0,
      code: "provider_unavailable",
    });
    expect(retryActivity?.every(Object.isFrozen)).toBe(true);
    expect(JSON.stringify(retryActivity)).not.toContain("Provider is temporarily unavailable.");
  }));

  it("runs Glob, Read, and Grep inside the Workspace scope", withExecutionScope(async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-read-only-tools-"));
    await mkdir(join(workspaceRoot, "src"));
    await writeFile(join(workspaceRoot, "src", "index.ts"), "export const value = 42;\n");

    const provider = new ScriptedProvider([
      {
        kind: "tool_call",
        reason: "List workspace files.",
        toolName: "Glob",
        input: { pattern: "**/*", path: "." },
      },
      {
        kind: "tool_call",
        reason: "Read the source file.",
        toolName: "Read",
        input: { file_path: "src/index.ts" },
      },
      {
        kind: "tool_call",
        reason: "Search for the exported value.",
        toolName: "Grep",
        input: { pattern: "value", path: "." },
      },
      {
        kind: "completion",
        summary: "Read-only tools completed.",
      },
    ]);

    const result = await executeReadOnlyTestHostRun({
      ...createTask(workspaceRoot),
      provider,
    });

    expect(result.product.status).toBe("completed");
    expect(result.product.output.agentSummary).toBe("Read-only tools completed.");
    expect(result.runResult.evidenceRefs).toHaveLength(0);
    expect(result.product.effects).toHaveLength(3);
    expect(result.product.effects.every((effect) => effect.status === "succeeded")).toBe(true);
    expect(result.activity.filter((item) => item.kind === "operation.finished")).toHaveLength(3);
    expect(provider.lastControllerResultCounts).toEqual([0, 1, 2, 3]);
    const modelCatalog = JSON.stringify(provider.requests[0]!.interaction);
    expect(modelCatalog).toContain("maxFileInspectionBytes");
    expect(modelCatalog).toContain("maxPerFileRegexMs");
    expect(modelCatalog).toContain("scan.complete");
    expect(operationOutputs(result)).toMatchObject([
      { matches: ["src", "src/index.ts"], truncated: false, omitted_count: 0, scan: {complete: true, skipped_count: 0} },
      { file_path: "src/index.ts", content: "export const value = 42;\n", truncated: false },
      {
        output_mode: "content",
        entries: [{ file_path: "src/index.ts", line: 1, text: "export const value = 42;" }],
        truncated: false,
        scan: {complete: true, files_searched: 1, skipped_count: 0},
      },
    ]);
  }));

  it("rejects selected managed enforcement without a matching provider", withExecutionScope(async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-managed-unavailable-"));
    const provider = new ScriptedProvider([{ kind: "completion", summary: "Must not run." }]);

    await expect(executeReadOnlyTestHostRun({
      ...createTask(workspaceRoot),
      provider,
      enforcement: "managed",
    })).rejects.toThrow("requires a matching SandboxProvider");
    expect(provider.requests).toHaveLength(0);
  }));

  it("fails malformed native output without structured-output correction", withExecutionScope(async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-output-exhausted-"));
    const firstInvalidOutput = "PRIVATE_INVALID_OUTPUT_1";
    const provider = new ScriptedProvider([
      firstInvalidOutput,
      "PRIVATE_INVALID_OUTPUT_2",
    ]);

    const result = await executeReadOnlyTestHostRun({
      ...createTask(workspaceRoot),
      provider,
    });

    expect(result.product.status).toBe("failed");
    expect(result.runResult).toMatchObject({
      status: "failed",
      cause: {
        kind: "failure",
        failure: {
          kind: "provider",
          failure: { code: "provider_request_failed" },
        },
      },
    });
    expect(result.runResult.items.some((item) =>
      item.payload.kind === "run_action"
    )).toBe(false);
    expect(provider.requests).toHaveLength(1);
    expect(JSON.stringify(provider.requests[0])).not.toContain(firstInvalidOutput);
  }));

  it("keeps command execution behind approval even when enforcement is disabled", withExecutionScope(async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-shell-denied-"));
    const markerPath = join(workspaceRoot, "marker.txt");
    const provider = new ScriptedProvider([
      {
        kind: "tool_call",
        reason: "Try a shell command.",
        toolName: nativeShellTool(),
        input: createShellInput(markerPath),
      },
      {
        kind: "completion",
        summary: "Permission was denied.",
      },
    ]);
    const result = await executeTestHostRun({
      ...createTask(workspaceRoot),
      provider,
      enableShell: true,
      permissionPreset: "approve_for_me",
      automaticApprovalReviewer: automaticReviewer("decline"),
    });

    expect(result.product.status, JSON.stringify(result, null, 2)).toBe("completed");
    expect(result.runResult.items.some((item) =>
      item.payload.kind === "pending_transition" &&
      item.payload.transition === "opened" &&
      item.payload.pending.kind === "interaction"
    )).toBe(true);
    expect(result.product.output.enforcement.status).toBe("denied");
    await expect(access(markerPath)).rejects.toThrow();
  }));

  it("does not weaken approval when the automatic reviewer is unavailable", withExecutionScope(async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-reviewer-unavailable-"));
    const markerPath = join(workspaceRoot, "marker.txt");
    const provider = new ScriptedProvider([
      {
        kind: "tool_call",
        reason: "Try a shell command.",
        toolName: nativeShellTool(),
        input: createShellInput(markerPath),
      },
      {
        kind: "completion",
        summary: "The automatic reviewer is unavailable.",
      },
    ]);

    const result = await executeTestHostRun({
      ...createTask(workspaceRoot),
      provider,
      enableShell: true,
      permissionPreset: "approve_for_me",
      automaticApprovalReviewer: unavailableAutomaticReviewer(),
    });

    expect(result.product.status, JSON.stringify(result, null, 2)).toBe("completed");
    expect(result.runResult.items.some((item) =>
      item.payload.kind === "pending_transition" &&
      item.payload.transition === "opened" &&
      item.payload.pending.kind === "interaction"
    )).toBe(true);
    expect(JSON.stringify(result.runResult.items)).toContain("approval_reviewer_unavailable");
    expect(result.product.output.enforcement.status).toBe("failed");
    await expect(access(markerPath)).rejects.toThrow();
  }));

  it("executes Full access commands through the explicit unisolated gateway", withExecutionScope(async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-shell-granted-"));
    const markerPath = join(workspaceRoot, "marker.txt");
    const registryPath = join(commandOutputDirectory, "locators.json");
    const registry = new CommandOutputRegistry(registryPath);
    const retained: Array<{ threadId: string; productRunId: string; runId: string; executionId: string }> = [];
    const provider = new ScriptedProvider([
      {
        kind: "tool_call",
        reason: "Create a marker.",
        toolName: nativeShellTool(),
        input: createShellInput(markerPath),
      },
      {
        kind: "completion",
        summary: "Shell command completed.",
      },
    ]);

    const result = await executeTestHostRun({
      ...createTask(workspaceRoot),
      provider,
      enableShell: true,
      permissionPreset: "full_access",
      retainCommandOutput: async (runId, executionId, paths) => {
        const scope = { threadId: "output-thread", productRunId: "output-work", runId, executionId };
        await registry.register(scope, executionId, commandOutputDirectory, paths);
        retained.push(scope);
      },
    });

    expect(result.product.status, JSON.stringify(result, null, 2)).toBe("completed");
    expect(result.product.output.agentSummary).toBe("Shell command completed.");
    expect(result.product.output.safeErrors).toEqual([]);
    const commandResults = result.runResult.items.flatMap((item) =>
      item.payload.kind === "observation" &&
        item.payload.observation.payload.kind === "operation"
        ? [item.payload.observation.payload.result]
        : []
    );
    expect(commandResults).toHaveLength(3);
    expect(commandResults.at(-1)).toMatchObject({
      status: "succeeded",
      output: {
        phase: expect.stringMatching(/^(draining|settled)$/),
        outcome: "succeeded",
        root_exit: { code: 0, signal: null },
        stdout: { integrity: "exact", omitted_bytes: 0 },
        stderr: { text: "", integrity: "exact", omitted_bytes: 0 },
      },
    });
    await expect(access(markerPath)).resolves.toBeUndefined();
    expect(await readdir(workspaceRoot)).toEqual(["marker.txt"]);
    expect(retained).toHaveLength(1);
    const reopened = new CommandOutputRegistry(registryPath);
    expect(await reopened.read({ ...retained[0]!, cursor: null }, undefined)).toMatchObject({ status: "page", source: "retained" });
    // Initial observation may precede capture finalization; retained output above
    // proves final persistence without rewriting that earlier observation.
    expect(commandResults.at(-1)?.output).not.toHaveProperty("output.files");
    expect(result.product.output.enforcement).toEqual({
      selected: "disabled",
      status: "unisolated",
      code: null,
    });
    expect(result.product.actions).toContainEqual(expect.objectContaining({
      status: "succeeded",
    }));
    expect(result.product.effects[0]?.lowerRefs).toContainEqual(expect.objectContaining({
      owner: "canonical-action",
      kind: "action_settlement",
    }));
    expect(provider.lastControllerResultCounts).toEqual([0, 1]);
  }));

  it("starts and stops one background shell task through its exact CommandStop identity", withExecutionScope(async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-background-shell-"));
    const provider = new ScriptedProvider([
      {
        kind: "tool_call",
        reason: "Start one bounded background task.",
        toolName: nativeShellTool(),
        input: {
          command: process.platform === "win32"
            ? "Start-Sleep -Seconds 30"
            : "sleep 30",
          timeout_ms: 60_000,
          description: "Start a test background task.",
          run_in_background: true,
        },
      },
      (request: ProviderRequest) => ({
        kind: "tool_call",
        reason: "Stop the exact background task.",
        toolName: "CommandStop",
        input: { task_id: readBackgroundTaskId(request) },
      }),
      { kind: "completion", summary: "Background task was stopped." },
    ]);

    const result = await executeTestHostRun({
      ...createTask(workspaceRoot),
      provider,
      permissionPreset: "full_access",
      instructionSettings: createDefaultHelarcInstructionSettings(),
    });

    expect(result.product.status, JSON.stringify(result, null, 2)).toBe("completed");
    expect(
      operationOutputs(result),
      JSON.stringify(operationResults(result), null, 2),
    ).toEqual([
      expect.objectContaining({ task_id: expect.any(String), snapshot: expect.objectContaining({ phase: "running" }) }),
      expect.objectContaining({ observation: expect.objectContaining({ phase: "running" }) }),
      expect.objectContaining({
        phase: "running",
        task_id: expect.any(String),
        return_reason: "immediate_snapshot",
      }),
      expect.objectContaining({
        snapshot: expect.objectContaining({ phase: "settled", containment: expect.objectContaining({ disposition: "empty" }) }),
        effect_certainty: "known_applied",
        task_id: expect.any(String),
      }),
    ]);
    expect(provider.lastControllerResultCounts).toEqual([0, 1, 2]);
    expect(provider.requests).toHaveLength(3);
    const priorResults = provider.requests[1]!.messages.filter(message => message.role === "tool");
    const subsequentResults = provider.requests[2]!.messages.filter(message => message.role === "tool");
    expect(JSON.stringify(priorResults)).toContain('"phase":"running"');
    expect(JSON.stringify(subsequentResults)).toContain('"outcome":"cancelled"');
    expect(provider.requests.every(request => !request.composition.sections.some(section => section.id === "helarc:model-input:command-state"))).toBe(true);
    expect(subsequentResults.slice(0, priorResults.length)).toEqual(priorResults);
    expect(provider.requests.every(request => request.instructions.content.length === 0)).toBe(true);
  }));

  it("delivers asynchronous timeout facts without CommandObserve or discarding a concurrent model response", withExecutionScope(async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-late-command-state-"));
    let active: HelarcHostActiveRun;
    const provider = new ScriptedProvider([
      { kind: "tool_call", toolName: nativeShellTool(), input: {
        command: process.platform === "win32" ? "Start-Sleep -Seconds 30" : "sleep 30",
        run_in_background: true, timeout_ms: 2_000,
      } },
      { kind: "plan_update", plan: [{ step: "Observe current command state", status: "in_progress" }] },
      { kind: "completion", summary: "The command timed out.", plan: [{ step: "Observe current command state", status: "completed" }] },
    ], async () => {
      if (provider.requests.length === 2) {
        await expect.poll(() => active.getProductProjection().commands[0]?.phase, { timeout: 5_000 }).toBe("settled");
      }
    });
    const prepared = await prepareTestHostRun({
      ...createTask(workspaceRoot), provider, permissionPreset: "full_access",
      instructionSettings: createDefaultHelarcInstructionSettings(),
    });
    const execution = prepared.start();
    active = execution.activeRun;
    const result = await execution.result;

    expect(result.runResult.status, JSON.stringify(result.product.output.safeErrors)).toBe("completed");
    expect(provider.requests).toHaveLength(3);
    const notices = provider.requests[2]!.composition.sections.filter(section => section.provenance?.purpose === "later_outcome");
    expect(notices.some(section => section.provenance?.sources.some(source => source.owner === "helarc-command") &&
      section.content.kind === "model_message" && JSON.stringify(section.content.message).includes('\\"outcome\\":\\"timed_out\\"')), JSON.stringify(notices)).toBe(true);
    const oldResults = provider.requests[1]!.messages.filter(message => message.role === "tool");
    expect(JSON.stringify(oldResults)).toContain('"phase":"running"');
    expect(provider.requests[2]!.messages.filter(message => message.role === "tool").slice(0, oldResults.length)).toEqual(oldResults);
    expect(operationResults(result).some(operation => operation.binding.operation.operation.name === "command-observe")).toBe(false);
    expect(provider.requests.every(request => request.instructions.content.length === 0)).toBe(true);
  }));

  it("observes a retained command and reads its immutable output through generic access without relaunch", withExecutionScope(async () => {
    const workspaceRoot=await mkdtemp(join(tmpdir(),"helarc-command-observation-"));
    const worker=pathToFileURL(join(process.cwd(),"dist/main/execution-storage/ExecutionStoreWorker.js"));
    const store=await openExecutionStoreFixture(join(workspaceRoot,"execution"),worker);
    const provider=new ScriptedProvider([
      {kind:"tool_call",toolName:nativeShellTool(),input:{
        command:process.platform==="win32" ? "Start-Sleep -Milliseconds 100; Write-Output 'retained-output'" : "sleep 0.1; printf retained-output",
        run_in_background:true,timeout_ms:10000}},
      (request:ProviderRequest)=>({kind:"tool_call",toolName:"CommandObserve",input:{task_id:readBackgroundTaskId(request),until:"settled",wait_ms:3000}}),
      (request:ProviderRequest)=>{
        const latest=request.messages.flatMap(message=>message.role==="tool" ? message.content.map(block=>block.result) : []).at(-1)!;
        const output=(latest.content as {output:{output_materials:{reference:{id:string;revision:string};stream:string}[]}}).output;
        expect(output).not.toHaveProperty("stdout");
        return {kind:"tool_call",toolName:"ContextMaterialRead",input:{reference:output.output_materials.find(value=>value.stream==="stdout")!.reference}};
      },
      (request:ProviderRequest)=>{
        const latest=request.messages.flatMap(message=>message.role==="tool" ? message.content.map(block=>block.result) : []).at(-1)!;
        expect(latest.settlement,JSON.stringify(latest)).toBe("succeeded");
        expect(JSON.stringify(latest.content)).toContain("retained-output");
        return {kind:"completion",summary:"Observed retained output."};
      },
    ]);
    try {
      const result=await executeTestHostRun({...createTask(workspaceRoot),provider,executionStore:store,permissionPreset:"full_access",
        instructionSettings:createDefaultHelarcInstructionSettings()});
      expect(result.product.status,JSON.stringify(result.product.output.safeErrors)).toBe("completed");
      const results=operationResults(result);
      expect(results.filter(value=>value.binding.operation.operation.name==="process-start")).toHaveLength(1);
      expect(results.find(value=>value.binding.operation.operation.name==="command-observe")).toMatchObject({status:"succeeded",output:{until:"settled",snapshot:{phase:"settled"}}});
      expect(results.find(value=>value.binding.operation.operation.name==="context-read")).toMatchObject({status:"succeeded",output:{text:expect.stringContaining("retained-output")}});
      expect(provider.requests.every(request=>request.instructions.content.length===0)).toBe(true);
    } finally {await store.close();}
  }), 20_000);

  it("submits the final Plan and reply together without another model request or enabled instructions", withExecutionScope(async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-final-plan-"));
    const provider = new ScriptedProvider([
      { kind: "plan_update", plan: [{ step: "Inspect workspace", status: "in_progress" }] },
      { kind: "completion", summary: "Inspection is complete.", plan: [{ step: "Inspect workspace", status: "completed" }] },
    ]);
    const result = await executeReadOnlyTestHostRun({
      ...createTask(workspaceRoot), provider, instructionSettings: createDefaultHelarcInstructionSettings(),
    });

    expect(result.runResult.status).toBe("completed");
    expect(provider.requests).toHaveLength(2);
    expect(provider.stopRequests).toHaveLength(0);
    expect(provider.requests.every(request => request.instructions.content.length === 0)).toBe(true);
    const required = provider.requests.map(request => request.interaction.kind === "native_tool_turn"
      ? request.interaction.callables.find(call => call.name === "final_result")?.inputSchema.required : null);
    expect(required).toEqual([[], ["plan"]]);
    const plans = result.runResult.items.flatMap(({ payload }) => payload.kind === "state_transition" && payload.transition === "plan" ? [payload.plan] : []);
    expect(plans).toHaveLength(2);
    expect(plans.at(-1)).toMatchObject({status: "completed", steps: [{step: "Inspect workspace", status: "completed"}]});
    const endingCalls = result.runResult.items.flatMap(({ payload }) => payload.kind === "model_call_settlement" && payload.result.name === "final_result" ? [payload.result] : []);
    expect(endingCalls).toHaveLength(1);
    expect(endingCalls[0]).toMatchObject({settlement: "succeeded", content: {stateUpdate: {settlement: "succeeded"}}});
    expect(result.product.output.agentSummary).toBe("Inspection is complete.");
  }));

  it.each([false, true])("ends a no-Plan Run in one request with no optional instructions (empty final Plan: %s)", withExecutionScope(async emptyPlan => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-no-plan-ending-"));
    const provider = new ScriptedProvider([
      {kind: "completion", summary: "Finished without a Plan.", ...(emptyPlan ? {plan: []} : {})},
    ]);
    const result = await executeReadOnlyTestHostRun({
      ...createTask(workspaceRoot), provider, instructionSettings: createDefaultHelarcInstructionSettings(),
    });
    expect(result.runResult.status, JSON.stringify(result.product.output.safeErrors)).toBe("completed");
    expect(provider.requests).toHaveLength(1);
    expect(provider.stopRequests).toHaveLength(0);
    expect(provider.requests[0]?.instructions.content).toHaveLength(0);
    expect(result.runResult.items.filter(({payload}) => payload.kind === "state_transition" && payload.transition === "plan")).toEqual([]);
    expect(result.runResult.items.filter(({payload}) => payload.kind === "controller_feedback")).toEqual([]);
    const settlements = result.runResult.items.flatMap(({payload}) => payload.kind === "model_call_settlement" ? [payload.result] : []);
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({name: "final_result", settlement: "succeeded"});
    expect(result.product.output.agentSummary).toBe("Finished without a Plan.");
  }));

  it("corrects an omitted final Plan without replaying a successful accompanying call", withExecutionScope(async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-final-plan-correction-"));
    await writeFile(join(workspaceRoot, "finding.txt"), "Retained finding.", "utf8");
    const provider = new ScriptedProvider([
      { kind: "plan_update", plan: [{step: "Inspect workspace", status: "in_progress"}] },
      { kind: "tool_calls", calls: [
        {kind: "tool_call", toolName: "Read", input: {file_path: "finding.txt"}},
        {kind: "completion", summary: "Premature response."},
      ] },
      { kind: "completion", summary: "Inspection is complete.", plan: [{step: "Inspect workspace", status: "completed"}] },
    ]);
    const result = await executeReadOnlyTestHostRun({
      ...createTask(workspaceRoot), provider, instructionSettings: createDefaultHelarcInstructionSettings(),
    });

    expect(result.runResult.status).toBe("completed");
    expect(provider.requests).toHaveLength(3);
    expect(provider.stopRequests).toHaveLength(0);
    expect(provider.requests.every(request => request.instructions.content.length === 0)).toBe(true);
    const returned = provider.requests[2]!.messages.flatMap(message => message.role === "tool" ? message.content.map(block => block.result) : []);
    expect(returned.at(-1)).toMatchObject({name: "final_result", settlement: "invalid", content: {
      code: "helarc_final_result_invalid", message: expect.stringContaining("plan is required"),
    }});
    expect(returned.at(-2)).toMatchObject({settlement: "succeeded"});
    expect(operationResults(result)).toHaveLength(1);
    expect(result.product.output.agentSummary).toBe("Inspection is complete.");
    expect(result.runResult.items.filter(({payload}) => payload.kind === "completion_acceptance")).toHaveLength(1);
  }));

  it("ends with an explicitly unchanged unfinished Plan without an extra model request or completion feedback", withExecutionScope(async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-plan-update-"));
    const provider = new ScriptedProvider([
      {
        kind: "plan_update",
        explanation: "The task has multiple steps.",
        plan: [
          { step: "Inspect workspace", status: "in_progress" },
          { step: "Finish task", status: "pending" },
        ],
      },
      {
        kind: "completion",
        summary: "Plan was recorded.",
        plan: [
          { step: "Inspect workspace", status: "in_progress" },
          { step: "Finish task", status: "pending" },
        ],
      },
    ]);

    const result = await executeReadOnlyTestHostRun({
      ...createTask(workspaceRoot),
      provider,
    });

    expect(result.product.status).toBe("completed");
    const recordedPlan = {
        id: `${result.harnessRunId}:plan:1`,
        version: 1,
        status: "active",
        steps: [
          { step: "Inspect workspace", status: "in_progress" },
          { step: "Finish task", status: "pending" },
        ],
      };
    expect(provider.lastControllerPlanExchanges).toEqual([[], [{
      input: {explanation: "The task has multiple steps.", plan: recordedPlan.steps},
      outcome: {kind: "plan_update", result: {status: "applied", transition: "created", planId: recordedPlan.id, version: 1}},
    }]]);
    expect(provider.requests).toHaveLength(2);
    expect(provider.stopRequests).toHaveLength(0);
    expect(result.runResult.items.filter(({ payload }) => payload.kind === "controller_feedback")).toHaveLength(0);
    const updates = result.runResult.items.flatMap(({ payload }) => payload.kind === "state_transition" && payload.transition === "plan" ? [payload.plan] : []);
    expect(updates).toHaveLength(2);
    expect(updates.at(-1)).toMatchObject({ status: "abandoned", steps: recordedPlan.steps });
    expect(result.product.output.agentSummary).toBe("Plan was recorded.");
  }));

  it.each(["completed", "pending"] as const)("preserves ordinary model Plan updates to %s without completion-time synchronization", withExecutionScope(async (status) => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-plan-sync-"));
    const provider = new ScriptedProvider([
      { kind: "plan_update", plan: [{ step: "Inspect workspace", status: "in_progress" }] },
      { kind: "plan_update", explanation: status === "completed" ? "Work is done." : "Inspection remains pending; no more work can be performed now.", plan: [{ step: "Inspect workspace", status }] },
      { kind: "completion", summary: "The Plan now records the actual state.", plan: [{ step: "Inspect workspace", status }] },
    ]);
    const result = await executeReadOnlyTestHostRun({ ...createTask(workspaceRoot), provider, instructionSettings: createDefaultHelarcInstructionSettings() });
    expect(result.runResult.status).toBe("completed");
    expect(provider.requests).toHaveLength(3);
    expect(provider.stopRequests).toHaveLength(0);
    expect(provider.requests.every((request) => request.interaction.kind === "native_tool_turn" && request.instructions.content.length === 0)).toBe(true);
    const updates = result.runResult.items.flatMap(({ payload }) => payload.kind === "state_transition" && payload.transition === "plan" ? [payload.plan] : []);
    expect(updates).toHaveLength(status === "completed" ? 2 : 3);
    expect(updates.at(-1)?.status).toBe(status === "completed" ? "completed" : "abandoned");
    expect(updates.at(-1)?.steps).toEqual([{ step: "Inspect workspace", status }]);
    expect(result.runResult.items.filter(({ payload }) => payload.kind === "controller_feedback")).toHaveLength(0);
    expect(result.runResult.items.some(({ payload }) => payload.kind === "suspension_transition")).toBe(false);
  }));

  it("delivers exact-name correction in Tool Results without system instructions or replaying valid siblings", withExecutionScope(async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-call-feedback-"));
    await writeFile(join(workspaceRoot, "first.txt"), "first result", "utf8");
    await writeFile(join(workspaceRoot, "second.txt"), "second result", "utf8");
    const provider = new ScriptedProvider([
      {
        kind: "tool_calls",
        calls: [
          { kind: "tool_call", callableName: "Read", input: { file_path: "first.txt" } },
          { kind: "tool_call", toolName: "Read", input: { file_path: "second.txt" } },
        ],
      },
      { kind: "tool_call", toolName: "Read", input: { file_path: "first.txt" } },
      { kind: "completion", summary: "Both files were read." },
    ]);
    const result = await executeReadOnlyTestHostRun({
      ...createTask(workspaceRoot), provider,
      instructionSettings: createDefaultHelarcInstructionSettings(),
    });

    expect(result.runResult.status).toBe("completed");
    expect(provider.requests).toHaveLength(3);
    expect(provider.stopRequests).toHaveLength(0);
    expect(provider.requests.every(request => request.instructions.content.length === 0)).toBe(true);
    const firstRequest = provider.requests[0]!;
    if (firstRequest.interaction.kind !== "native_tool_turn") throw new Error("Expected native request.");
    const names = firstRequest.interaction.callables.map(({ name }) => name);
    const readName = names.find(name => name.startsWith("Read_"))!;
    const nextRequest = provider.requests[1]!;
    const toolResults = nextRequest.messages.flatMap(message =>
      message.role === "tool" ? message.content.map(block => block.result) : []);
    expect(toolResults).toHaveLength(2);
    expect(toolResults[0]).toMatchObject({
      name: "Read", settlement: "invalid",
      content: { kind: "model_call_rejected", code: "model_callable_unknown",
        message: expect.stringContaining(JSON.stringify(names)) },
    });
    expect(toolResults[1]).toMatchObject({ name: readName, settlement: "succeeded" });
    const calls = nextRequest.messages.flatMap(message => message.role === "assistant"
      ? message.content.flatMap(block => block.kind === "model_tool_call" ? [block.call] : []) : []);
    expect(calls).toHaveLength(2);
    expect(toolResults.map(({ modelCallRef, providerCallRef }) => ({ modelCallRef, providerCallRef })))
      .toEqual(calls.map(({ modelCallRef, providerCallRef }) => ({ modelCallRef, providerCallRef })));
    expect(JSON.stringify(toolResults[1]!.content)).toContain("second result");

    const finalResults = provider.requests[2]!.messages.flatMap(message =>
      message.role === "tool" ? message.content.map(block => block.result) : []);
    expect(finalResults).toHaveLength(3);
    expect(finalResults[2]).toMatchObject({ name: readName, settlement: "succeeded" });
    expect(JSON.stringify(finalResults[2]!.content)).toContain("first result");
    expect(operationResults(result)).toHaveLength(2);
    expect(operationResults(result).every(operation => operation.status === "succeeded")).toBe(true);
  }));

  it("allows bounded Controller correction after three rejected Actions", withExecutionScope(async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-action-correction-"));
    const provider = new ScriptedProvider([
      {
        kind: "plan_update",
        plan: [{ step: "Inspect workspace", status: "started" }],
      },
      {
        kind: "tool_call",
        toolName: "Glob",
        input: { directory: "." },
      },
      {
        kind: "tool_call",
        toolName: "Read",
        input: { file: "Program.cs" },
      },
      {
        kind: "completion",
        summary: "Corrected the rejected decisions.",
      },
    ]);

    const result = await executeReadOnlyTestHostRun({
      ...createTask(workspaceRoot),
      provider,
    });

    expect(result.runResult).toMatchObject({ status: "completed" });
    expect(result.product.status).toBe("completed");
    expect(result.product.runActions.map(({ status }) => status)).toEqual([
      "rejected",
      "rejected",
      "rejected",
    ]);
    expect(provider.requests).toHaveLength(4);
    expect(provider.lastControllerResultCounts).toEqual([0, 1, 2, 3]);
  }));

  it("executes multiple model-origin file mutations and continues until completion", withExecutionScope(async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-file-mutations-"));
    await mkdir(join(workspaceRoot, "src"));
    await writeFile(join(workspaceRoot, "src", "existing.txt"), "before\n");
    const provider = new ScriptedProvider([
      {
        kind: "tool_call",
        toolName: "Write",
        input: { file_path: "src/created.txt", content: "created\n" },
      },
      {
        kind: "tool_call",
        toolName: "Edit",
        input: {
          file_path: "src/existing.txt",
          old_string: "before",
          new_string: "after",
        },
      },
      { kind: "completion", summary: "Both file changes are complete." },
    ]);

    const result = await executeTestHostRun({
      ...createTask(workspaceRoot),
      provider,
      permissionPreset: "full_access",
    });

    expect(result.product.status).toBe("completed");
    expect(result.product.output.agentSummary).toBe("Both file changes are complete.");
    expect(result.product.effects).toHaveLength(2);
    expect(result.product.effects.every(({ status }) => status === "succeeded")).toBe(true);
    expect(result.product.actions).toHaveLength(2);
    expect(provider.requests).toHaveLength(3);
    expect(provider.lastControllerResultCounts).toEqual([0, 1, 2]);
    await expect(readFile(join(workspaceRoot, "src", "created.txt"), "utf8"))
      .resolves.toBe("created\n");
    await expect(readFile(join(workspaceRoot, "src", "existing.txt"), "utf8"))
      .resolves.toBe("after\n");
  }));

  it("derives generic approval review from the exact prepared Write action", withExecutionScope(async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-write-approved-"));
    const targetPath = join(workspaceRoot, "approved.txt");
    const reviewedInputs: ApprovalReviewInput[] = [];
    const provider = new ScriptedProvider([
      {
        kind: "tool_call",
        toolName: "Write",
        input: { file_path: "approved.txt", content: "approved\n" },
      },
      { kind: "completion", summary: "The approved write completed." },
    ]);

    const result = await executeTestHostRun({
      ...createTask(workspaceRoot),
      provider,
      permissionPreset: "approve_for_me",
      automaticApprovalReviewer: automaticReviewer("accept", (input) => {
        reviewedInputs.push(input);
      }),
    });

    expect(result.product.status).toBe("completed");
    expect(reviewedInputs[0]?.request.category).toBe("fileChange");
    expect(reviewedInputs[0]?.request.payload).toMatchObject({
      changes: [{ operation: "create", displayPath: "approved.txt" }],
    });
    await expect(readFile(targetPath, "utf8")).resolves.toBe("approved\n");
  }));

  it("does not execute a Write when generic approval is declined", withExecutionScope(async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-write-declined-"));
    const targetPath = join(workspaceRoot, "declined.txt");
    const provider = new ScriptedProvider([
      {
        kind: "tool_call",
        toolName: "Write",
        input: { file_path: "declined.txt", content: "must not exist\n" },
      },
      { kind: "completion", summary: "The requested file change was declined." },
    ]);

    const result = await executeTestHostRun({
      ...createTask(workspaceRoot),
      provider,
      permissionPreset: "approve_for_me",
      automaticApprovalReviewer: automaticReviewer("decline"),
    });

    expect(result.product.status).toBe("completed");
    expect(result.product.output.enforcement.status).toBe("denied");
    await expect(access(targetPath)).rejects.toThrow();
  }));

  it("keeps approval review and statistics after the former cumulative request limit", withExecutionScope(async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-unbounded-approvals-"));
    let reviewCount = 0;
    const started = performance.now();
    const timings: {stage: string; elapsedMs: number}[] = [];
    const mark = (stage: string) => timings.push({stage, elapsedMs: Math.round(performance.now() - started)});
    const provider = new ScriptedProvider([
      ...Array.from({length: 9}, (_, index) => ({kind: "tool_call", toolName: "Write",
        input: {file_path: `approved-${index}.txt`, content: "approved\n"}})),
      {kind: "completion", summary: "All nine individually reviewed writes completed."},
    ], () => {mark("model_request");});
    try {
      const prepared = await prepareTestHostRun({...createTask(workspaceRoot), provider,
        permissionPreset: "approve_for_me", automaticApprovalReviewer: automaticReviewer("accept", () => { reviewCount += 1; mark("approval"); })});
      const composition = prepared.start();
      const result = await composition.result;
      mark("settled");
      expect(result.product.status).toBe("completed");
      expect(reviewCount).toBe(9);
      expect(composition.activeRun.getProjection().runTree.approvals).toMatchObject({totalRequests: 9, settledRequests: 9,
        activeReviews: 0, exhaustedCode: null});
      await expect(readFile(join(workspaceRoot, "approved-8.txt"), "utf8")).resolves.toBe("approved\n");
    } finally {
      console.log("Approval composition timings", JSON.stringify(timings));
      await rm(workspaceRoot, {recursive: true, force: true});
    }
  }), 20_000);

  it("rejects an ambiguous Edit without changing the file", withExecutionScope(async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-edit-ambiguous-"));
    const targetPath = join(workspaceRoot, "duplicate.txt");
    await writeFile(targetPath, "same same\n");
    const provider = new ScriptedProvider([
      {
        kind: "tool_call",
        toolName: "Edit",
        input: {
          file_path: "duplicate.txt",
          old_string: "same",
          new_string: "changed",
        },
      },
      { kind: "completion", summary: "The exact edit was ambiguous." },
    ]);

    const result = await executeTestHostRun({
      ...createTask(workspaceRoot),
      provider,
      permissionPreset: "full_access",
    });

    expect(result.product.status).toBe("completed");
    expect(result.product.output.safeErrors).toContainEqual(expect.objectContaining({
      code: "file_edit_ambiguous",
    }));
    await expect(readFile(targetPath, "utf8")).resolves.toBe("same same\n");
  }));

  it("round trips exact Read text through literal Edit including CRLF, BOM and dollar sequences", withExecutionScope(async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-literal-edit-"));
    const targetPath = join(workspaceRoot, "target.txt");
    const original = "\uFEFFbefore\r\nsecond\n";
    const replacement = "\uFEFF$& $$ $` $' $1\r\nsecond\n";
    await writeFile(targetPath, original);
    const provider = new ScriptedProvider([
      {kind: "tool_call", toolName: "Read", input: {file_path: "target.txt"}},
      (request: ProviderRequest) => {
        const results = request.messages.flatMap(message => message.role === "tool"
          ? message.content.map(block => block.result.content) : []);
        expect(results).toMatchObject([{output: {content: original, next_offset: null}}]);
        return {kind: "tool_call", toolName: "Edit", input: {
          file_path: "target.txt", old_string: original, new_string: replacement,
        }};
      },
      {kind: "completion", summary: "Literal edit applied."},
    ]);
    try {
      const result = await executeTestHostRun({...createTask(workspaceRoot), provider, permissionPreset: "full_access"});
      expect(operationResults(result).map(operation => operation.status)).toEqual(["succeeded", "succeeded"]);
      expect(await readFile(targetPath, "utf8")).toBe(replacement);
    } finally { await rm(workspaceRoot, {recursive: true, force: true}); }
  }), 20_000);

  it("returns the unchanged-file failure facts before accepting a corrected Edit", withExecutionScope(async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-edit-feedback-"));
    const targetPath = join(workspaceRoot, "target.txt");
    await writeFile(targetPath, "before\n");
    const provider = new ScriptedProvider([
      { kind: "tool_call", toolName: "Edit", input: {
        file_path: "target.txt", old_string: "not present", new_string: "after",
      } },
      (request: ProviderRequest) => {
        const results = request.messages.flatMap(message => message.role === "tool"
          ? message.content.map(block => block.result) : []);
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
          settlement: "invalid", content: {
            status: "invalid", output: null, effectCertainty: "none", completionExtent: "none",
            failure: { code: "file_edit_no_match", message: expect.stringContaining("This attempt did not modify the file.") },
          },
        });
        return { kind: "tool_call", toolName: "Edit", input: {
          file_path: "target.txt", old_string: "before", new_string: "after",
        } };
      },
      { kind: "completion", summary: "The corrected edit was applied." },
    ]);
    const result = await executeTestHostRun({
      ...createTask(workspaceRoot), provider, permissionPreset: "full_access",
    });
    expect(result.product.status).toBe("completed");
    expect(operationResults(result).map(operation => operation.status)).toEqual(["invalid", "succeeded"]);
    const finalResults = provider.requests[2]!.messages.flatMap(message => message.role === "tool"
      ? message.content.map(block => block.result) : []);
    expect(finalResults).toMatchObject([
      { settlement: "invalid", content: { effectCertainty: "none", completionExtent: "none" } },
      { settlement: "succeeded", content: { effectCertainty: "confirmed", completionExtent: "complete" } },
    ]);
    await expect(readFile(targetPath, "utf8")).resolves.toBe("after\n");
  }));

  it("reports a rejected Write as not executed without producing an Action or file", withExecutionScope(async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-write-rejected-"));
    const provider = new ScriptedProvider([
      { kind: "tool_call", toolName: "Write", input: {
        file_path: "target.txt", content: "not written", old_string: "unsupported", replace_all: false,
      } },
      { kind: "completion", summary: "The attempted write was rejected." },
    ]);
    const result = await executeTestHostRun({
      ...createTask(workspaceRoot), provider, permissionPreset: "full_access",
    });
    const results = provider.requests[1]!.messages.flatMap(message => message.role === "tool"
      ? message.content.map(block => block.result) : []);
    expect(results).toMatchObject([{ settlement: "invalid", content: {
      kind: "tool_rejected", code: "tool_input_invalid",
      message: expect.stringContaining("The requested Tool operation was not executed."),
      issues: expect.arrayContaining([expect.objectContaining({ path: "/old_string", reason: "unexpected" })]),
    } }]);
    expect(operationResults(result)).toEqual([]);
    expect(result.product.actions).toEqual([]);
    await expect(access(join(workspaceRoot, "target.txt"))).rejects.toThrow();
  }));

  it("exposes effective command limits and returns a correctable schema rejection before Action preparation", withExecutionScope(async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-command-contract-"));
    const provider = new ScriptedProvider([
      {kind: "tool_call", toolName: process.platform === "win32" ? "PowerShell" : "Bash", input: {command: "echo should-not-start", timeout_ms: 180000}},
      {kind: "completion", summary: "The command was not started."},
    ]);
    const result = await executeTestHostRun({...createTask(workspaceRoot), provider, permissionPreset: "full_access",
      commandLimits: {defaultTimeoutMs: 1200, maxTimeoutMs: 4000}});
    const exposed = JSON.stringify(provider.requests[0]!.interaction);
    expect(exposed).toContain('"maximum":4000');
    expect(exposed).toContain('"default":1200');
    const feedback = JSON.stringify(provider.requests[1]!.messages.filter(message => message.role === "tool"));
    expect(feedback).toContain("180000"); expect(feedback).toContain("4000"); expect(feedback).toContain("1200");
    expect(operationResults(result)).toEqual([]);
    expect(result.product.actions).toEqual([]);
    expect(provider.requests).toHaveLength(2);
  }));

  it("invalidates an approved Edit when its prepared baseline becomes stale", withExecutionScope(async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "helarc-edit-stale-"));
    const targetPath = join(workspaceRoot, "stale.txt");
    await writeFile(targetPath, "before\n");
    const provider = new ScriptedProvider([
      {
        kind: "tool_call",
        toolName: "Edit",
        input: {
          file_path: "stale.txt",
          old_string: "before",
          new_string: "after",
        },
      },
      { kind: "completion", summary: "The prepared baseline became stale." },
    ]);

    const result = await executeTestHostRun({
      ...createTask(workspaceRoot),
      provider,
      permissionPreset: "approve_for_me",
      automaticApprovalReviewer: automaticReviewer("accept", async () => {
        await writeFile(targetPath, "changed externally\n");
      }),
    });

    expect(result.product.status).toBe("completed");
    expect(result.product.output.safeErrors).toContainEqual(expect.objectContaining({
      code: "file_target_changed",
    }));
    await expect(readFile(targetPath, "utf8")).resolves.toBe("changed externally\n");
  }));
});

function operationOutputs(result: Awaited<ReturnType<typeof executeTestHostRun>>): unknown[] {
  return operationResults(result).map((operation) => operation.output);
}

function operationResults(result: Awaited<ReturnType<typeof executeTestHostRun>>) {
  return result.runResult.items.flatMap((item) =>
    item.payload.kind === "observation" &&
      item.payload.observation.payload.kind === "operation"
      ? [item.payload.observation.payload.result]
      : []
  );
}

function automaticReviewer(
  decisionKind: "accept" | "decline",
  onReview: (input: ApprovalReviewInput) => void | Promise<void> = () => {},
) {
  return {
    bindingId: `test-auto-${decisionKind}`,
    kind: "auto_review" as const,
    descriptor: {
      id: `test-auto-${decisionKind}`,
      kind: "auto_review" as const,
      displayName: "Test automatic reviewer",
      source: "helarc-session-test",
      metadata: {},
    },
    reviewer: {
      async review(input: ApprovalReviewInput) {
        await onReview(input);
        const option = input.request.decisionOptions.find(({ kind }) => kind === decisionKind);
        if (option === undefined) throw new Error(`Missing '${decisionKind}' decision option.`);
        return {
          status: "decided" as const,
          submission: {
            submissionId: `test-submission-${decisionKind}`,
            runId: input.request.runId,
            requestId: input.request.id,
            pendingVersion: input.pendingVersion,
            optionId: option.id,
            grantedPermissions: null,
            reason: decisionKind === "decline" ? "Denied by test reviewer." : null,
          },
          rationale: null,
        };
      },
    },
    reviewTimeoutMs: 1_000,
  };
}

function unavailableAutomaticReviewer() {
  return {
    bindingId: "test-auto-unavailable",
    kind: "auto_review" as const,
    descriptor: {
      id: "test-auto-unavailable",
      kind: "auto_review" as const,
      displayName: "Unavailable automatic reviewer",
      source: "helarc-session-test",
      metadata: {},
    },
    reviewer: {
      async review() {
        return {
          status: "failed" as const,
          failure: {
            code: "approval_reviewer_unavailable" as const,
            message: "Automatic reviewer is unavailable.",
            retryable: false,
            metadata: {},
          },
        };
      },
    },
    reviewTimeoutMs: 1_000,
  };
}

class ScriptedProvider implements Provider {
  readonly stopRequests: ProviderRequest[] = [];
  private readonly context = createFakeProviderContext(
    "scripted-helarc-provider",
    "host-run-test-model",
  );
  readonly modelContext = this.context.modelContext;
  readonly requestBodyTransportLimit = this.context.requestBodyTransportLimit;
  readonly descriptor = {
    id: "scripted-helarc-provider",
    name: "Scripted Helarc Provider",
    capabilities: {
      nativeToolInteraction: {
        supported: true as const,
        callableDefinitions: true as const,
        modelCalls: true as const,
        resultMessages: true as const,
        multipleCalls: true,
        callCorrelation: "provider_supplied" as const,
      },
      structuredGeneration: { supported: true as const },
      streaming: { supported: false as const },
      modelContext: providerModelContextCapability(this.modelContext),
      continuation: { supported: false as const },
      compaction: { supported: false as const },
      usageMetering: {
        inputTokens: "unavailable" as const,
        outputTokens: "unavailable" as const,
        costUnits: "unavailable" as const,
      },
    },
    requestRetryScheduler: { kind: "harness" as const },
    metadata: {},
  };
  readonly requests: ProviderRequest[] = [];
  readonly lastControllerResultCounts: number[] = [];
  readonly lastControllerPlanExchanges: unknown[] = [];

  constructor(
    private readonly outputs: unknown[],
    private readonly beforeResponse: (request: ProviderRequest) => void | Promise<void> = () => {},
  ) {}

  async send(
    request: ProviderRequest,
    _context: InvocationInterruptionContext,
  ): Promise<ProviderCallResult> {
    if (request.purpose === "helarc.task-fulfillment") {
      this.stopRequests.push(request);
      return scriptedTaskFulfillmentResult(request, this.descriptor.id);
    }
    this.requests.push(request);
    expect(findTextBlock(request, "Context projection:")).toBeUndefined();
    this.lastControllerResultCounts.push(request.messages.reduce((count, message) =>
      count + (message.role === "tool" ? message.content.length : 0), 0));
    this.lastControllerPlanExchanges.push(readPlanExchanges(request));
    await this.beforeResponse(request);
    const scriptedOutput = this.outputs.shift();
    if (scriptedOutput === undefined) {
      return {
        kind: "failed",
        failure: {
          category: "fake",
          code: "script_exhausted",
          message: "Scripted provider exhausted.",
          metadata: {},
        },
      };
    }

    const output = typeof scriptedOutput === "function"
      ? scriptedOutput(request)
      : scriptedOutput;

    return scriptedNativeProviderResult(
      request,
      output,
      this.descriptor.id,
      this.requests.length,
    );
  }
}

class RetryThenCompleteProvider implements Provider {
  private readonly context = createFakeProviderContext(
    "retry-then-complete-provider",
    "host-run-test-model",
  );
  readonly modelContext = this.context.modelContext;
  readonly requestBodyTransportLimit = this.context.requestBodyTransportLimit;
  readonly descriptor = {
    id: "retry-then-complete-provider",
    name: "Retry Then Complete Provider",
    capabilities: {
      nativeToolInteraction: {
        supported: true as const,
        callableDefinitions: true as const,
        modelCalls: true as const,
        resultMessages: true as const,
        multipleCalls: true,
        callCorrelation: "provider_supplied" as const,
      },
      structuredGeneration: { supported: true as const },
      streaming: { supported: false as const },
      modelContext: providerModelContextCapability(this.modelContext),
      continuation: { supported: false as const },
      compaction: { supported: false as const },
      usageMetering: {
        inputTokens: "unavailable" as const,
        outputTokens: "unavailable" as const,
        costUnits: "unavailable" as const,
      },
    },
    requestRetryScheduler: { kind: "harness" as const },
    metadata: {},
  };
  readonly requests: ProviderRequest[] = [];

  async send(request: ProviderRequest): Promise<ProviderCallResult> {
    if (request.purpose === "helarc.task-fulfillment") {
      return scriptedTaskFulfillmentResult(request, this.descriptor.id);
    }
    this.requests.push(request);
    if (this.requests.length === 1) {
      return {
        kind: "failed",
        failure: {
          category: "transport",
          code: "provider_unavailable",
          message: "Provider is temporarily unavailable.",
          retryAfterMs: 0,
          metadata: {},
        },
      };
    }

    return scriptedNativeProviderResult(
      request,
      { kind: "completion", summary: "Recovered after retry." },
      this.descriptor.id,
      this.requests.length,
    );
  }
}

function scriptedTaskFulfillmentResult(
  request: ProviderRequest,
  providerId: string,
): ProviderCallResult {
  if (request.interaction.kind !== "structured_generation") {
    return providerTestFailure("task_fulfillment_request_kind_invalid");
  }
  return Object.freeze({
    kind: "succeeded" as const,
    response: snapshotProviderResponse({
      kind: "structured_generation",
      output: Object.freeze({
        status: "fulfilled", disposition: "allow",
        rationale: "The scripted Host Run fixture accepts the settled trajectory.",
        missingOutcomes: Object.freeze([]),
        unsupportedClaims: Object.freeze([]),
      }),
      responseId: `${providerId}:task-fulfillment`,
      continuation: null,
      usage: null,
      metadata: Object.freeze({ fixture: true }),
    }),
  });
}

function scriptedNativeProviderResult(
  request: ProviderRequest,
  output: unknown,
  providerId: string,
  responseSequence: number,
): ProviderCallResult {
  if (request.interaction.kind !== "native_tool_turn") {
    return providerTestFailure("provider_request_kind_invalid");
  }
  if (typeof output === "string") {
    return providerTestFailure("model_output_invalid");
  }
  if (typeof output !== "object" || output === null || !("kind" in output)) {
    return providerTestFailure("model_output_invalid");
  }

  const scripted = output as Record<string, unknown>;
  const responseId = `${providerId}:response:${responseSequence}`;
  const turnId = createModelTurnId({
    providerId,
    requestId: request.requestId,
    responseId,
  });
  const assistantText = Array.isArray(scripted.assistantTexts)
    ? scripted.assistantTexts.map((text) => ({ kind: "text" as const, text: String(text) }))
    : [];
  const calls = scripted.kind === "tool_calls"
    ? scripted.calls as Record<string, unknown>[]
    : [scripted];
  const content = [...assistantText, ...calls.map((call, index) => Object.freeze({
        kind: "model_tool_call" as const,
        call: snapshotModelCallableRequest({
          modelCallRef: createModelCallRef({
            providerRequestId: request.requestId,
            controllerRequestId: request.correlation.controllerRequestId,
            turnId,
            contentBlockOrdinal: assistantText.length + index,
            branchId: request.correlation.branchId,
          }),
          providerCallRef: { providerId, id: `${responseId}:call:${index}` },
          name: scriptedCallableName(request, call),
          input: scriptedCallInput(call),
          ordinal: assistantText.length + index,
        }),
      }))];

  return {
    kind: "succeeded",
    response: snapshotProviderResponse({
      kind: "native_tool_turn",
      turn: {
        turnId,
        assistant: { role: "assistant", content },
        finish: { kind: "normal" },
        usage: null,
        responseRef: { providerId, requestId: request.requestId, responseId },
      },
      continuation: null,
      metadata: {},
    }),
  };
}

function scriptedCallableName(
  request: ProviderRequest,
  scripted: Record<string, unknown>,
): string {
  if (typeof scripted.callableName === "string") return scripted.callableName;
  if (scripted.kind === "completion") return "final_result";
  if (scripted.kind === "plan_update") return "update_plan";
  if (scripted.kind !== "tool_call" || typeof scripted.toolName !== "string") {
    return "unknown_scripted_callable";
  }
  const stem = scripted.toolName.replace(/[^A-Za-z0-9_-]/gu, "_").replace(/_+/gu, "_")
    .replace(/^_+|_+$/gu, "").slice(0, 42) || "tool";
  return request.interaction.kind === "native_tool_turn"
    ? request.interaction.callables.find(({ name }) => name.startsWith(`${stem}_`))?.name ??
      `unknown_${stem}`
    : `unknown_${stem}`;
}

function scriptedCallInput(scripted: Record<string, unknown>): {
  readonly [key: string]: ModelJsonValue;
} {
  if (scripted.kind === "completion") return {
    response: String(scripted.summary),
    ...(scripted.plan === undefined ? {} : {plan: scripted.plan as ModelJsonValue}),
  };
  if (scripted.kind === "plan_update") {
    return {
      ...(typeof scripted.explanation === "string"
        ? { explanation: scripted.explanation }
        : {}),
      plan: scripted.plan as ModelJsonValue,
    };
  }
  return scripted.input as { readonly [key: string]: ModelJsonValue };
}

function providerTestFailure(code: string): ProviderCallResult {
  return {
    kind: "failed",
    failure: {
      category: "fake",
      code,
      message: "Scripted provider could not create a native Model Turn.",
      metadata: {},
    },
  };
}

function providerModelContextCapability(modelContext: Provider["modelContext"]) {
  return {
    capacity: modelContext.capacity,
    requestedOutput: modelContext.requestedOutput,
    inputPreservation: modelContext.inputPreservation,
  };
}

function createTask(workspaceRoot: string) {
  const result = createHelarcTask({
    taskId: "helarc-task-1",
    prompt: "Inspect the workspace.",
    createdAt: "2026-06-28T00:00:00.000Z",
  });

  if (!result.ok) {
    throw new Error(result.error.message);
  }

  return {
    task: result.task,
    workspace: {
      primary: {
        id: "workspace",
        name: "workspace",
        rootRef: workspaceRoot,
        trustState: "trusted" as const,
        source: "test",
        policyRefs: [],
        metadata: {},
      },
      additional: [],
    },
  };
}

function readPlanExchanges(request: ProviderRequest): readonly unknown[] {
  expect(findTextBlock(request, "Current plan:")).toBeUndefined();
  const calls = new Map<string, unknown>();
  const exchanges = [];
  for (const message of request.messages) {
    if (message.role === "assistant") for (const block of message.content) {
      if (block.kind === "model_tool_call" && block.call.name === "update_plan") calls.set(block.call.modelCallRef.id, block.call.input);
    }
    if (message.role === "tool") for (const {result} of message.content) {
      if (calls.has(result.modelCallRef.id)) exchanges.push({input: calls.get(result.modelCallRef.id), outcome: result.content});
    }
  }
  return exchanges;
}

function findTextBlock(request: ProviderRequest, marker: string): string | undefined {
  for (const message of request.messages) {
    for (const block of message.content) {
      if (block.kind === "text" && block.text.startsWith(marker)) return block.text;
    }
  }
  return undefined;
}

function readBackgroundTaskId(request: ProviderRequest): string {
  const match = /\"task_id\"\s*:\s*\"([^\"]+)\"/.exec(
    request.messages.map(modelMessageText).join("\n"),
  );
  if (match?.[1] === undefined) {
    throw new Error("The background task observation did not contain task_id.");
  }
  return match[1];
}

function modelMessageText(message: ProviderRequest["messages"][number]): string {
  return message.content
    .map((block) => block.kind === "text" ? block.text : JSON.stringify(block))
    .join("");
}

function createShellInput(markerPath: string) {
  return {
    command: process.platform === "win32"
      ? `[System.IO.File]::WriteAllText('${markerPath.replaceAll("'", "''")}', 'ran')`
      : `printf 'ran' > '${markerPath.replaceAll("'", "'\\''")}'`,
    timeout_ms: 5_000,
    description: "Create a governed marker file.",
  };
}

function nativeShellTool(): "Bash" | "PowerShell" {
  return process.platform === "win32" ? "PowerShell" : "Bash";
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for Helarc Host Run state.");
}

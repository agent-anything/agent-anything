import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createPreparedAction } from "@agent-anything/action-execution/registration";
import { createActionRegistrationSnapshot } from "@agent-anything/canonical-action/registration";
import { createCanonicalActorIdentity, createCanonicalEnvironmentIdentity } from "@agent-anything/canonical-action/subject";
import type { ActionPreparationRecord, ActionDispatchIntent, ActionAttemptResultRecord, ActionSettlementRecord } from "@agent-anything/action-execution/enforcement";
import { CanonicalActionLedger } from "@agent-anything/action-execution/coordination";
import { ExecutionDatabase } from "./ExecutionDatabase.js";
import { HelarcExecutionStore } from "./HelarcExecutionStore.js";
import { ActionExecutionCoordinator } from "@agent-anything/action-execution/enforcement";
import { EXECUTION_STORE_LIMITS } from "./ExecutionStoreProtocol.js";
import {packExecutionContent, EXECUTION_CONTENT_LIMITS} from "./ExecutionContent.js";
import type { RunCommit, RunTreeCommit } from "@agent-anything/agent-runtime/runner";
import { RunTreeCommitWriter } from "@agent-anything/agent-runtime/runner";
import { CompositeExecution, type CompositeCommit } from "@agent-anything/operation-composition/execution";
import {snapshotExecutionEvidence, type ExecutionReferenceTransfer} from "@agent-anything/operation-catalog/evidence";

const directories: string[] = [];
const databases: ExecutionDatabase[] = [];
const stores: HelarcExecutionStore[] = [];
const testBuild = process.env.HELARC_EXECUTION_TEST_BUILD ?? "dist";
const compiledWorker = pathToFileURL(join(process.cwd(), testBuild, "main/execution-storage/ExecutionStoreWorker.js"));
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close().catch(() => {});
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function directory(): string { const value = mkdtempSync(join(tmpdir(), "helarc-execution-")); directories.push(value); return value; }
function open(path: string): ExecutionDatabase { const value = new ExecutionDatabase(path); databases.push(value); return value; }

it("retains exact reference transfers and stable bounded public-execution pages across reopening", () => {
  const path = directory(), database = open(path);
  database.commitRunTree(database.generation, treeCommit(0, true));
  const operation = {operation: {namespace: "files", name: "write"}, revision: "1"};
  for (let index = 0; index < 20; index++) database.commitExecutionEvidence(database.generation, snapshotExecutionEvidence({
    ref: {owner: "files", kind: "execution", id: `execution-${String(index).padStart(2, "0")}`, revision: "1"},
    source: {result: {id: `result-${index}`, invocation: {id: `invocation-${index}`, operation}}, resultRevision: "1", binding: {operation, revision: "1"},
      correlation: {kind: "run_action", run: {id: "run-2"}, runAction: {id: `action-${index}`, run: {id: "run-2"}, sequence: index + 1},
        materializationRevision: 1, provenance: {kind: "automatic", trigger: {owner: "test", operationId: "test"}}}, lowerRefs: []},
    outcome: {status: "succeeded", effectCertainty: "none", completionExtent: "complete"}, recordedAt: "2026-10-16T00:00:00.000Z",
    coverage: {scope: "Observed outcome", extent: "partial", limitations: []}, effects: [], support: [],
  }));
  const first = database.readRunExecutionRefs("run-2", null, 16);
  expect(first.references).toHaveLength(16); expect(first.next).not.toBeNull();
  expect(database.readRunExecutionRefs("run-1", null, 16)).toEqual({references: [], next: null});
  const transfer: ExecutionReferenceTransfer = {id: "handoff-1", sourceRunId: "run-2", recipientRunId: "run-1",
    scope: {kind: "references", references: [first.references[0]!]}, basis: {owner: "host", kind: "accepted_input", id: "input-1", revision: "1"}, acceptedAt: "2026-10-16T00:00:00.000Z"};
  database.commitReferenceTransfer(database.generation, transfer);
  database.commitReferenceTransfer(database.generation, transfer);
  expect(() => database.commitReferenceTransfer(database.generation, {...transfer, scope: {kind: "public_run"}})).toThrow("execution_transfer_conflict");
  expect(() => database.commitReferenceTransfer(database.generation, {...transfer, id: "foreign", sourceRunId: "run-1", recipientRunId: "run-2"})).toThrow("execution_transfer_source_invalid");
  database.close();
  const reopened = open(path);
  expect(reopened.readReferenceTransfers("run-1")).toEqual([transfer]);
  expect(reopened.readRunExecutionRefs("run-2", first.next, 16)).toMatchObject({references: expect.any(Array), next: null});
  expect(reopened.readRunExecutionRefs("run-2", first.next, 16).references).toHaveLength(4);
  const tamper = new Database(join(path, "execution.sqlite"));
  tamper.prepare("UPDATE execution_reference_transfers SET value=?").run(JSON.stringify({...transfer, scope: {kind: "public_run"}})); tamper.close();
  expect(() => reopened.readReferenceTransfers("run-1")).toThrow("execution_transfer_corrupt");
});

// Real Worker restarts and FULL durable commits are not five-second unit tests.
describe("execution owner persistence", {timeout: 20_000}, () => {
  it("keeps large checkpoints, staged-but-unpublished content and historical roots across actual Worker reopen", async () => {
    const root = directory();
    const first = treeCommit(0);
    const large = {...first, runs: first.runs.map(run => ({...run, control: {...run.control,
      controllerCheckpoints: [["retained-response", {revision: 1, value: Array.from({length: 22000}, (_, id) => ({id, result: {text: "retained", done: true}}))}]],
    }}))} as unknown as RunTreeCommit;
    let store = await HelarcExecutionStore.open(root, compiledWorker); stores.push(store);
    await store.commitRunTree(large);
    expect(await store.readRunTreeCommit(large.id)).toEqual(large);
    await store.close();
    const database = open(root);
    const stage = packExecutionContent({notPublished: "orphan stage"});
    database.stageContent(database.generation, stage.blocks);
    expect(database.readLatestRunTree("run-1")).toEqual(large);
    database.close();
    store = await HelarcExecutionStore.open(root, compiledWorker); stores.push(store);
    expect(await store.commitRunTree(large)).toMatchObject({recordId: large.id});
    expect((await store.readRunTree("run-1"))?.members[0]?.head).toEqual(large.runs[0]);
    const next = treeCommit(1);
    await store.commitRunTree(next);
    expect(await store.readRunTreeCommit(large.id)).toEqual(large);
    expect(await store.readLatestRunTree("run-1")).toEqual(next);
    await store.close();
    const raw = new Database(join(root, "execution.sqlite"));
    const row = raw.prepare("SELECT value FROM run_tree_commits WHERE record_id=?").get(large.id) as {value: string};
    expect(Buffer.byteLength(row.value)).toBeLessThan(256);
    expect((raw.prepare("SELECT MAX(length(value)) AS size FROM execution_content").get() as {size: number}).size).toBeLessThan(EXECUTION_CONTENT_LIMITS.blockBytes);
    raw.prepare("DELETE FROM execution_content WHERE id=?").run(JSON.parse(row.value).root); raw.close();
    expect(() => open(root).readRunTreeCommit(large.id)).toThrow("execution_records_corrupt");
  }, 60000);
  it("records the unacknowledged commit and queued requests on the existing timeout", async () => {
    const record = vi.fn();
    const worker = pathToFileURL(join(process.cwd(), "tests/fixtures/execution-storage-unresponsive-worker.mjs"));
    const store = await HelarcExecutionStore.open(directory(), worker, undefined, undefined, {record});
    stores.push(store);
    vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "performance"]});
    try {
      const commit = treeCommit(0);
      const first = expect(store.commitRunTree(commit)).rejects.toMatchObject({code: "execution_storage_acknowledgement_unknown"});
      const queued = expect(store.readLatestRun("run-1")).rejects.toMatchObject({code: "execution_storage_not_dispatched"});
      await vi.advanceTimersByTimeAsync(EXECUTION_STORE_LIMITS.acknowledgementMs);
      await first;
      await queued;
      expect(record).toHaveBeenCalledWith("storage_acknowledgement_timeout", expect.objectContaining({
        command: "commit_run_tree", commitId: commit.runs[0]!.id, treeCommitId: commit.id,
        pendingRequests: 1, acknowledgementMs: EXECUTION_STORE_LIMITS.acknowledgementMs,
        elapsedMs: EXECUTION_STORE_LIMITS.acknowledgementMs,
      }), expect.objectContaining({code: "execution_storage_acknowledgement_unknown"}));
    } finally {vi.useRealTimers();}
  });

  it("preserves the original Worker exception and commit context without changing rejection or later writes", async () => {
    const record = vi.fn();
    const store = await HelarcExecutionStore.open(directory(), compiledWorker, undefined, undefined, {record});
    stores.push(store);
    const first = treeCommit(0);
    await store.commitRunTree(first);
    const next = treeCommit(1);
    const inconsistent = {...next, checkpoint: {...next.checkpoint,
      nodes: next.checkpoint.nodes.map(node => ({...node, status: "waiting" as const}))}};
    await expect(store.commitRunTree(inconsistent)).rejects.toMatchObject({
      code: "execution_storage_failed", cause: {name: "TypeError", message: expect.stringContaining("Run lifecycle"), stack: expect.any(String)},
    });
    expect(record).toHaveBeenCalledWith("storage_worker_rejected", expect.objectContaining({
      command: "commit_run_tree", runId: "run-1", commitId: next.runs[0]!.id, treeCommitId: next.id,
      revision: 1, requestId: expect.any(Number), elapsedMs: expect.any(Number),
    }), expect.objectContaining({code: "execution_storage_failed", cause: expect.any(Error)}));
    expect(await store.readLatestRunTree("run-1")).toEqual(first);
    expect(await store.commitRunTree(next)).toMatchObject({revision: 1});
  });

  it("refuses offline command cleanup while an acknowledged Run retains its output", async () => {
    const root = directory();
    const output = join(root, "command-output");
    await mkdir(output);
    const capture = join(output, "retained.txt");
    await writeFile(capture, "retained output");
    const database = open(join(root, "execution"));
    database.commitRunTree(database.generation, treeCommit(0));
    database.close();
    const modulePath = pathToFileURL(join(process.cwd(), "scripts/clear-command-output.mjs")).href;
    const {clearCommandOutput} = await import(modulePath);
    await expect(clearCommandOutput(root, {log() {}})).rejects.toThrow("cleanup refused");
    expect(await readFile(capture, "utf8")).toBe("retained output");
  });
  it.each(["stop", "retry"] as const)("retains a %s decision across Worker restart without re-deciding or resetting attempts", async status => {
    const data = await fixture(2);
    const path = directory();
    const original = await HelarcExecutionStore.open(path, compiledWorker);
    stores.push(original);
    const preparation = await original.recordPreEffect(data.preparation);
    const intent = await original.recordDispatchIntent({...data.intent, preparationRecordId: preparation.recordId});
    const result = {...data.result, intentRecordId: intent.recordId, result: {...data.result.result,
      status: "settled" as const, outcome: {status: "failed" as const, effectState: "none" as const,
        failure: {code: "transient", message: "Transient failure", retryable: true, metadata: {}}}}} as ActionAttemptResultRecord;
    await original.recordAttemptResult(result);
    const decision = status === "stop" ? {status, code: "stop_retrying"} : {status,
      replayBasis: {kind: "confirmed_no_effect" as const, evidenceRef: "executor-no-effect"}, delayMs: 10_000, decisionRecordId: "retry-1"};
    const retry = {intentRecordId: intent.recordId, runId: "run-1", action: {id: "action-1"},
      attempt: data.intent.ledger.attempts[0]!, decision, decidedAt: "2026-10-13T00:00:00.000Z",
      notBefore: status === "retry" ? "2026-10-13T00:00:10.000Z" : null,
      remainingAttempts: 1, limits: data.preparation.limits};
    const receipt = await original.recordRetry(retry);
    expect(await original.recordRetry(retry)).toEqual(receipt);
    await expect(original.recordRetry({...retry, remainingAttempts: 2})).rejects.toMatchObject({code: "execution_record_conflict"});
    await original.close();
    const store = await HelarcExecutionStore.open(path, compiledWorker);
    stores.push(store);
    const {registrationFingerprint: _fingerprint, ...registration} = data.preparation.registration;
    const execute = vi.fn(async (request: Parameters<import("@agent-anything/action-execution/sandbox").SandboxExecutionGateway["execute"]>[0]) =>
      ({...data.result.result, attempt: request.attempt}));
    const wait = vi.fn(async () => "elapsed" as const);
    const decide = vi.fn(async (): Promise<never> => {throw new Error("Must reuse retained retry");});
    const coordinator = new ActionExecutionCoordinator({
      registrations: createActionRegistrationSnapshot([registration]), records: store,
      adapters: [{adapter: {descriptor: registration.adapter,
        async prepare() {throw new Error("Must reuse prepared subject");},
        async revalidate() {return {status: "valid", recordId: "baseline"};},
        async settle(_prepared, settlement) {return {operationInvocationId: settlement.operationInvocation.id, settlement,
          status: settlement.status === "succeeded" ? "succeeded" : "failed", output: settlement.payload, failure: null};},
      }}],
      policy: {async evaluate() {return data.preparation.policy;}},
      permission: {async assess() {return data.preparation.permission;}, async consumeActionCoverage() {throw new Error("No coverage");}},
      approval: null, sandbox: {execute, async cancel() {return {status: "already_settled"};}}, retry: {decide, wait},
      now: () => "2026-10-13T00:00:04.000Z",
    });
    const {request} = recoveryCoordinator(store, data.preparation);
    const recovered = await coordinator.recover({...request, maxAttempts: 2, isProgressionBasisCurrent: () => true,
      authority: {...request.authority, isBasisCurrent: () => true}}, {records: store, attempts: null});
    expect(recovered).toMatchObject({settlement: {status: status === "retry" ? "succeeded" : "failed"}});
    expect(decide).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(status === "retry" ? 1 : 0);
    if (status === "retry") {
      expect(wait).toHaveBeenCalledWith(expect.objectContaining({delayMs: 6_000}));
      expect(execute.mock.calls[0]![0].attempt.ordinal).toBe(2);
    }
    const retained = await store.readAction({runId: "run-1", action: {id: "action-1"}});
    expect(retained.attempts[0]?.retry).toEqual(retry);
    expect(retained.attempts).toHaveLength(status === "retry" ? 2 : 1);
  });

  it("commits a staged Child admission through the Runtime writer and restores the same combined basis", async () => {
    const root = directory();
    const store = await HelarcExecutionStore.open(root, compiledWorker);
    stores.push(store);
    const initial = treeCommit(0);
    const writer = new RunTreeCommitWriter(initial.checkpoint, store, () => initial.checkpoint.input.startedAt);
    await writer.transaction(() => ({runs: initial.runs, value: undefined}));
    const admission = treeCommit(1, true);
    await writer.transaction(({tree}) => {
      const child = admission.checkpoint.nodes[1]!;
      const reserved = tree.reserveDescendant({relationId: "relation-1", relationKind: "delegation",
        createChildRunId: () => "run-2", parentRunId: "run-1", parentLineage: tree.rootLineage,
        parentRunAction: child.lineage.kind === "descendant" ? child.lineage.parentRunAction : null!,
        parentDeadlineAt: initial.checkpoint.input.deadlineAt, childLocalDeadlineAt: initial.checkpoint.input.deadlineAt,
        resourceAllocation: admission.checkpoint.resources.nodes[1]!.requestedAllocation,
        authorityRevision: child.admittedAuthorityRevision, dispatch: child.dispatch!});
      expect(reserved.status).toBe("accepted");
      tree.markStarted("run-2", initial.checkpoint.input.startedAt);
      tree.updateLifecycle("run-2", "running");
      return {runs: admission.runs, value: undefined};
    });
    const saved = writer.getSnapshot();
    await store.close();
    const reopened = await HelarcExecutionStore.open(root, compiledWorker);
    stores.push(reopened);
    const recovered = await RunTreeCommitWriter.recover("run-1", reopened, () => initial.checkpoint.input.startedAt);
    expect(recovered?.getSnapshot()).toEqual(saved);
    expect(recovered?.getSnapshot()?.members.map(member => member.head.state.run.id)).toEqual(["run-1", "run-2"]);
    await recovered!.transaction(({tree}) => {
      tree.recordResources("run-2", {actions: {status: "measured", value: 1}});
      return {runs: [], value: undefined};
    });
    expect((await reopened.readRunTree("run-1"))?.commit.revision).toBe(2);
    expect((await reopened.readLatestRun("run-2"))?.state.revision).toBe(0);
  });

  it("commits Run and tree heads together, with no standalone bypass after admission", () => {
    const database = open(directory());
    const first = treeCommit(0);
    database.commitRunTree(database.generation, first);
    expect(database.readLatestRunTree("run-1")).toEqual(first);
    expect(() => database.commitOwner(database.generation, {kind: "run", value: runCommit(1)})).toThrow("execution_coordinated_commit_required");
    const next = treeCommit(1);
    const inconsistent = {...next, checkpoint: {...next.checkpoint,
      nodes: next.checkpoint.nodes.map(node => ({...node, status: "waiting" as const}))}};
    expect(() => database.commitRunTree(database.generation, inconsistent)).toThrow("Run lifecycle");
    expect(database.readOwnerCommit(next.runs[0]!.id)).toBeNull();
    expect(database.readLatestRunTree("run-1")).toEqual(first);
    expect(database.commitRunTree(database.generation, next)).toMatchObject({recordId: next.id, revision: 1});
    expect(database.readLatestOwner("run", "run-1")?.value).toEqual(next.runs[0]);
    expect(() => database.commitRunTree(database.generation, {...next, runs: []})).toThrow("execution_record_conflict");
  });

  it("requires Child admission and retained membership in the same tree transaction", () => {
    const database = open(directory());
    database.commitRunTree(database.generation, treeCommit(0));
    const withChild = treeCommit(1, true);
    expect(() => database.commitRunTree(database.generation, {...withChild, runs: [withChild.runs[0]!]})).toThrow("membership");
    expect(database.readOwnerCommit("run-1:commit:1")).toBeNull();
    database.commitRunTree(database.generation, withChild);
    expect(database.readOwnerCommit("run-2:commit:0")?.value).toEqual(withChild.runs[1]);
    expect(() => database.commitRunTree(database.generation, {...treeCommit(2), runs: []})).toThrow("membership");
    expect(database.readOwnerCommit("run-1:commit:2")).toBeNull();
    const noRunChange = {...withChild, id: "run-1:tree_commit:2", expectedRevision: 1, revision: 2, runs: []};
    expect(database.commitRunTree(database.generation, noRunChange)).toMatchObject({revision: 2, runs: []});
    expect(database.readLatestOwner("run", "run-1")?.value.state.revision).toBe(1);
    expect(database.readRunTree("run-1")).toEqual({commit: noRunChange, members: [
      {admission: treeCommit(0).runs[0]!.admission, head: withChild.runs[0]},
      {admission: withChild.runs[1]!.admission, head: withChild.runs[1]},
    ]});
    expect(database.readRunTree("not-recorded")).toBeNull();
  });

  it("rejects partial pre-recording instead of pretending it was an atomic tree admission", () => {
    const database = open(directory());
    const first = treeCommit(0);
    database.commitOwner(database.generation, {kind: "run", value: first.runs[0]!});
    expect(() => database.commitRunTree(database.generation, first)).toThrow("execution_partial_tree_commit");
    expect(database.readLatestRunTree("run-1")).toBeNull();
  });

  it("preserves combined Run/Child admission after losing the Worker acknowledgement", async () => {
    const root = directory();
    const worker = pathToFileURL(join(process.cwd(), "tests/fixtures/execution-storage-crash-worker.mjs"));
    const store = await HelarcExecutionStore.open(root, worker);
    stores.push(store);
    const commit = treeCommit(0, true);
    await expect(store.commitRunTree(commit)).rejects.toThrow("execution_storage_acknowledgement_unknown");
    await store.close().catch(() => {});
    const reopened = await HelarcExecutionStore.open(root, compiledWorker);
    stores.push(reopened);
    expect(await reopened.readRunTreeCommit(commit.id)).toEqual(commit);
    expect(await reopened.readLatestRunTree("run-1")).toEqual(commit);
    expect(await reopened.commitRunTree(commit)).toMatchObject({recordId: commit.id, revision: 0, runs: [
      {recordId: "run-1:commit:0", revision: 0}, {recordId: "run-2:commit:0", revision: 0},
    ]});
    expect(await reopened.readLatestRun("run-2")).toEqual(commit.runs[1]);
    expect(await reopened.readRunTree("run-1")).toEqual({commit,
      members: commit.runs.map(head => ({admission: head.admission, head}))});
    await expect(reopened.commitRun(commit.runs[0]!)).rejects.toThrow("execution_coordinated_commit_required");
  });

  it("rejects changed original tree policy, stale generations and corrupt coordinated records", () => {
    const path = directory();
    const database = open(path);
    database.commitRunTree(database.generation, treeCommit(0));
    const next = treeCommit(1);
    const changed = structuredClone(next);
    Object.assign(changed.checkpoint.input, {deadlineAt: "2027-01-01T00:00:00Z"});
    expect(() => database.commitRunTree(database.generation, changed)).toThrow("original tree facts");
    expect(database.readOwnerCommit("run-1:commit:1")).toBeNull();
    database.close();
    const reopened = open(path);
    expect(() => reopened.commitRunTree(database.generation, next)).toThrow("execution_owner_stale");
    expect(() => reopened.commitRunTree(reopened.generation, treeCommit(2))).toThrow("execution_commit_revision_stale");
    reopened.close();
    const raw = new Database(join(path, "execution.sqlite"));
    raw.exec("UPDATE run_tree_commits SET digest='corrupt'");
    raw.close();
    expect(() => open(path).readLatestRunTree("run-1")).toThrow("execution_records_corrupt");
  });

  it.each(["recorded", "reconciled", "unknown"] as const)("recovers a %s physical outcome across Worker reopen without another dispatch", async mode => {
    const root = directory();
    const original = await HelarcExecutionStore.open(root, compiledWorker);
    stores.push(original);
    const data = await fixture();
    const preparation = await original.recordPreEffect(data.preparation);
    const intent = await original.recordDispatchIntent({...data.intent, preparationRecordId: preparation.recordId});
    if (mode === "recorded") await original.recordAttemptResult({...data.result, intentRecordId: intent.recordId});
    await original.close();
    const store = await HelarcExecutionStore.open(root, compiledWorker);
    stores.push(store);
    const {coordinator, request, execute} = recoveryCoordinator(store, data.preparation);
    const reconcile = vi.fn(async () => ({status: "settled" as const, result: data.result.result, evidenceRefs: ["owner:receipt:1"]}));
    const result = await coordinator.recover(request, {records: store, attempts: mode === "unknown" ? null : {reconcile}});
    expect(result).toMatchObject({status: "settled", settlement: {status: mode === "unknown" ? "unknown_effect" : "succeeded"}});
    expect(execute).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledTimes(mode === "reconciled" ? 1 : 0);
    const retained = await store.readAction({runId: "run-1", action: {id: "action-1"}});
    expect(retained.attempts).toHaveLength(1);
    if (mode === "unknown") {
      expect(retained.attempts[0]!.result).toBeNull();
      expect(retained.settlement).toMatchObject({sandbox: null,
        reconciliation: {status: "unknown", intentRecordId: intent.recordId},
        settlement: {effectCertainty: "unknown", reconciliationRequired: true}});
    }
    if (mode === "reconciled") expect(retained.attempts[0]!.result?.reconciliation?.evidenceRefs).toEqual(["owner:receipt:1"]);
    await store.close();
    const reopened = await HelarcExecutionStore.open(root, compiledWorker);
    stores.push(reopened);
    const again = recoveryCoordinator(reopened, data.preparation);
    expect(await again.coordinator.recover(again.request, {records: reopened, attempts: {reconcile}})).toEqual(result);
    expect(again.execute).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledTimes(mode === "reconciled" ? 1 : 0);
  });

  it("atomically stores state and control, rejects conflicting revisions and retains exact replay across generations", () => {
    const root = directory();
    const database = open(root);
    const first = runCommit(0);
    const second = runCommit(1);
    expect(database.commitOwner(database.generation, {kind: "run", value: first})).toEqual({recordId: first.id, revision: 0});
    database.commitOwner(database.generation, {kind: "run", value: second});
    expect(database.readLatestOwner("run", "run-1")).toEqual({kind: "run", value: second});
    expect(() => database.commitOwner(database.generation, {kind: "run", value: {...second, control: {...second.control, steering: {epoch: 2, pending: [], ledger: []}}}})).toThrow("execution_record_conflict");
    expect(() => database.commitOwner(database.generation, {kind: "run", value: runCommit(3)})).toThrow("execution_commit_revision_stale");
    const invalid = runCommit(2);
    expect(() => database.commitOwner(database.generation, {kind: "run", value: {...invalid, state: {...invalid.state, deadlineAt: "2027-01-01T00:00:00Z"}}})).toThrow("execution_record_reference_invalid");
    database.close();
    const reopened = open(root);
    expect(() => reopened.commitOwner(database.generation, {kind: "run", value: first})).toThrow("execution_owner_stale");
    expect(reopened.commitOwner(reopened.generation, {kind: "run", value: second})).toEqual({recordId: second.id, revision: 1});
    expect(reopened.readOwnerCommit(second.id)).toEqual({kind: "run", value: second});
    expect(() => reopened.commitOwner(reopened.generation, {kind: "run", value: {...invalid, state: {...invalid.state, items: []}}})).toThrow("execution_record_reference_invalid");
  });

  it("does not replace retained owner facts when an instruction binding or stored digest is invalid", () => {
    const root = directory();
    const database = open(root);
    const first = runCommit(0);
    const invalid = {...first, control: {...first.control, instructionBinding: {...first.control.instructionBinding, ref: {id: "other", revision: "1"}}}};
    expect(() => database.commitOwner(database.generation, {kind: "run", value: invalid})).toThrow("execution_record_reference_invalid");
    expect(database.readLatestOwner("run", "run-1")).toBeNull();
    database.commitOwner(database.generation, {kind: "run", value: first});
    database.close();
    const raw = new Database(join(root, "execution.sqlite"));
    raw.prepare("UPDATE execution_commits SET digest='changed'").run();
    raw.close();
    expect(() => open(root).readOwnerCommit(first.id)).toThrow("execution_records_corrupt");
  });

  it("recovers the same Run commit after Worker acknowledgement loss without accepting a replacement", async () => {
    const root = directory();
    const worker = pathToFileURL(join(process.cwd(), "tests/fixtures/execution-storage-crash-worker.mjs"));
    const store = await HelarcExecutionStore.open(root, worker);
    stores.push(store);
    const commit = runCommit(0);
    await expect(store.commitRun(commit)).rejects.toThrow("execution_storage_acknowledgement_unknown");
    await store.close().catch(() => {});
    const reopened = await HelarcExecutionStore.open(root, compiledWorker);
    stores.push(reopened);
    expect(await reopened.readRunCommit(commit.id)).toEqual(commit);
    expect(await reopened.commitRun(commit)).toEqual({recordId: commit.id, revision: 0});
    expect(await reopened.readLatestRun("run-1")).toEqual(commit);
  });

  it("stores real Composite prepared requests and settlements through the Worker before dependent execution", async () => {
    const root = directory();
    const store = await HelarcExecutionStore.open(root, compiledWorker);
    stores.push(store);
    const commits: CompositeCommit[] = [];
    const operation = {operation: {namespace: "test", name: "read"}, revision: "1"};
    const definition = {
      ref: {id: "test.composite", revision: "1"}, inputSchemaRevision: "1", resultSchemaRevision: "1", graphRevision: "1",
      nodes: ["first", "second"].map((id, index) => ({id, operation, allowedBindings: ["internal" as const],
        dependencies: index === 0 ? [] : [{nodeId: "first", requirement: "settled" as const}],
        transformId: "identity", conditionId: null, resourceClaims: [], required: true})),
      join: {kind: "all_selected_settled" as const}, reducerId: "reduce", conflictPolicyRevision: "1",
      limits: {maxNodes: 2, maxParallel: 2}, cancellationPolicy: "cancel_unstarted_and_signal_active" as const,
      sensitivity: "internal" as const, retiredAt: null,
    };
    const execution = new CompositeExecution("composite-1", definition, {
      commits: {runId: "run-1", port: {
        async commitComposite(commit) {
          const receipt = await store.commitComposite(commit);
          commits.push(structuredClone(commit));
          return receipt;
        }, readCompositeCommit: id => store.readCompositeCommit(id),
      }},
      now: () => "2026-10-14T00:00:00.000Z", conditions: [], conflicts: null,
      transforms: [{id: "identity", transform: ({compositeInput, dependencies}) => ({compositeInput, dependencies})}],
      reducer: {id: "reduce", reduce: ({children, aggregateStatus, aggregateFailure}) => ({status: aggregateStatus, output: {count: children.length}, failure: aggregateFailure}) as never},
      children: {async start(input) {
        const saved = await store.readCompositeCommit(commits.at(-1)!.id);
        expect(saved?.requests.find(entry => entry.nodeId === input.node.id)?.request).toEqual(input.request);
        if (input.node.id === "second") expect(saved?.state.nodes[0]?.settlement?.failure?.code).toBe("test_child_failure");
        return {runAction: null, result: null, failure: {code: "test_child_failure", message: "Known failure", retryable: false, metadata: {}}};
      }},
    });
    const result = await execution.run({path: "file"}, {
      signal: new AbortController().signal,
      checkpoint: () => ({status: "active"}),
    } as never);
    expect(result.status).toBe("failed");
    await store.close();
    const database = open(root);
    expect(database.readLatestOwner("composite", "composite-1")?.value.state).toEqual(execution.getSnapshot());
    expect(() => database.commitOwner(database.generation, {kind: "composite", value: {
      ...commits.at(-1)!, id: `composite-1:commit:${execution.getSnapshot().revision + 1}`,
      expectedRevision: execution.getSnapshot().revision,
      state: {...execution.getSnapshot(), revision: execution.getSnapshot().revision + 1},
    }})).toThrow("execution_owner_already_settled");
  });
  it("records a real Coordinator lifecycle through the durable port before acknowledging its result", async () => {
    const root = directory();
    const store = await HelarcExecutionStore.open(root, compiledWorker);
    stores.push(store);
    const { preparation, result } = await fixture();
    const { registrationFingerprint: _fingerprint, ...registration } = preparation.registration;
    let sequence = 0;
    let executions = 0;
    const coordinator = new ActionExecutionCoordinator({
      registrations: createActionRegistrationSnapshot([registration]),
      records: store,
      adapters: [{ adapter: {
        descriptor: registration.adapter,
        async prepare() { return { status: "prepared", prepared: preparation.prepared }; },
        async revalidate() { return { status: "valid", recordId: "current-baseline" }; },
        async settle(_prepared, settlement) { return {
          operationInvocationId: settlement.operationInvocation.id, settlement,
          status: "succeeded", output: settlement.payload, failure: null,
        }; },
      } }],
      policy: { async evaluate() { return preparation.policy; } },
      permission: {
        async assess() { return preparation.permission; },
        async consumeActionCoverage() { return { status: "consumed", recordId: "consumed" }; },
      },
      approval: null,
      sandbox: {
        async execute(input) {
          executions += 1;
          const records = await store.readAction({ runId: "run-1", action: { id: "action-1" } });
          expect(records.attempts).toHaveLength(1);
          expect(records.attempts[0]!.intent.request.attempt.id).toBe(input.attempt.id);
          expect(records.attempts[0]!.result).toBeNull();
          return { ...result.result, attempt: input.attempt };
        },
        async cancel() { return { status: "already_settled" }; },
      },
      retry: { async decide() { return { status: "stop", code: "not_retrying" }; }, async wait() { return "elapsed"; } },
      now: () => "2026-10-13T00:00:00.000Z", createId: kind => `${kind}-${++sequence}`,
    });
    await expect(coordinator.execute({
      action: { id: "action-1" }, runId: "run-1", parentRunAction: preparation.prepared.subject.parentRunAction,
      binding: preparation.binding,
      securityContext: { workspace: null, actor: preparation.prepared.subject.actor, environment: preparation.prepared.subject.environment },
      policyContext: { policySnapshotId: "policy-1", workspaceTrustState: "trusted", identityId: "user", environmentId: "local", metadata: {} },
      permissionContext: () => ({ authoritySnapshotId: "permission-1" } as never),
      enforcement: "disabled", interruption: { signal: new AbortController().signal } as never,
      deadlineAt: "2026-10-13T01:00:00.000Z", maxAttempts: 1, isProgressionBasisCurrent: () => true,
      authority: { captureBasis: () => ({ authorityRevision: "1", resourceRevision: 1 }), isBasisCurrent: () => true },
    })).resolves.toMatchObject({ status: "settled", settlement: { status: "succeeded" } });
    expect(executions).toBe(1);
    await store.close();
    const saved = open(root).readAction("run-1", "action-1");
    expect(saved.preparations).toHaveLength(1);
    expect(saved.attempts[0]!.result).not.toBeNull();
    expect(saved.settlement?.settlement.status).toBe("succeeded");
  });

  it("continues a Composite from a committed prepared request after reopen without repeating its completed sibling", async () => {
    const root = directory();
    const original = await HelarcExecutionStore.open(root, compiledWorker);
    stores.push(original);
    const operation = {operation: {namespace: "test", name: "read"}, revision: "1"};
    const definition = {
      ref: {id: "test.restart", revision: "1"}, inputSchemaRevision: "1", resultSchemaRevision: "1", graphRevision: "1",
      nodes: ["first", "second"].map((id, index) => ({id, operation, allowedBindings: ["internal" as const],
        dependencies: index === 0 ? [] : [{nodeId: "first", requirement: "settled" as const}],
        transformId: "identity", conditionId: null, resourceClaims: [], required: true})),
      join: {kind: "all_selected_settled" as const}, reducerId: "reduce", conflictPolicyRevision: "1",
      limits: {maxNodes: 2, maxParallel: 2}, cancellationPolicy: "cancel_unstarted_and_signal_active" as const,
      sensitivity: "internal" as const, retiredAt: null,
    };
    const started: string[] = [];
    const transform = vi.fn(({compositeInput}: {compositeInput: unknown}) => compositeInput);
    const dependencies = {
      now: () => "2026-10-15T00:00:00.000Z", conditions: [], conflicts: null,
      transforms: [{id: "identity", transform}],
      reducer: {id: "reduce", reduce: ({aggregateStatus, aggregateFailure}: {aggregateStatus: string; aggregateFailure: unknown}) =>
        ({status: aggregateStatus, output: null, failure: aggregateFailure}) as never},
      children: {async start(input: {node: {id: string}; request: unknown}) {
        started.push(input.node.id);
        expect(input.request).toEqual({path: "same-file"});
        return {runAction: null, result: null, failure: {code: "known_failure", message: "Known result", retryable: false, metadata: {}}};
      }},
    };
    const interrupted = new CompositeExecution("restart-composite", definition, {...dependencies,
      commits: {runId: "run-1", port: {
        readCompositeCommit: id => original.readCompositeCommit(id),
        async commitComposite(commit) {
          const receipt = await original.commitComposite(commit);
          if (commit.state.nodes[1]?.lifecycle === "prepared") throw new Error("Lost acknowledgement after commit.");
          return receipt;
        },
      }},
    });
    const interruption = {signal: new AbortController().signal, checkpoint: () => ({status: "active"})} as never;
    await expect(interrupted.run({path: "same-file"}, interruption)).rejects.toThrow(/commit was not confirmed/);
    expect(started).toEqual(["first"]);
    await original.close();
    const store = await HelarcExecutionStore.open(root, compiledWorker);
    stores.push(store);
    const checkpoint = await store.readLatestComposite("restart-composite");
    expect(checkpoint?.state.nodes[1]?.lifecycle).toBe("prepared");
    const reconcile = vi.fn();
    const resumed = new CompositeExecution("restart-composite", definition, {...dependencies,
      commits: {runId: "run-1", port: store}, recovery: {checkpoint: checkpoint!, reconcile},
    });
    const result = await resumed.run({path: "same-file"}, interruption);
    expect(started).toEqual(["first", "second"]);
    expect(transform).toHaveBeenCalledTimes(2);
    expect(reconcile).not.toHaveBeenCalled();
    expect(result.children[0]).toEqual(checkpoint?.state.nodes[0]?.settlement);
    expect((await store.readLatestComposite("restart-composite"))?.state.terminal).toEqual(result);
  });

  it("persists prepared input, each attempt and settlement with exact idempotent receipts", async () => {
    const root = directory();
    const database = open(root);
    const records = await fixture();
    const prepared = database.recordAction(database.generation, { kind: "preparation", value: records.preparation });
    records.intent = { ...records.intent, preparationRecordId: prepared.recordId };
    const intent = database.recordAction(database.generation, { kind: "dispatch_intent", value: records.intent });
    records.result = { ...records.result, intentRecordId: intent.recordId };
    database.recordAction(database.generation, { kind: "attempt_result", value: records.result });
    const settled = database.recordAction(database.generation, { kind: "settlement", value: records.settlement });
    expect(database.recordAction(database.generation, { kind: "settlement", value: records.settlement })).toEqual(settled);
    expect(() => database.recordAction(database.generation, { kind: "settlement", value: {
      ...records.settlement, settlement: { ...records.settlement.settlement, status: "failed" },
    } })).toThrow("execution_record_conflict");
    database.close();
    const reopened = open(root);
    expect(reopened.generation).toBe(database.generation + 1);
    expect(reopened.readReceipt(settled.recordId)).toEqual(settled);
    expect(reopened.readAction("run-1", "action-1")).toEqual({
      preparations: [{ recordId: prepared.recordId, value: records.preparation }],
      attempts: [{ recordId: intent.recordId, intent: records.intent, result: records.result, retry: null }],
      settlement: records.settlement,
    });
    expect(() => reopened.recordAction(database.generation, { kind: "preparation", value: records.preparation })).toThrow("execution_owner_stale");
  });

  it("retains an admitted intent as unresolved rather than declaring it not executed", async () => {
    const root = directory();
    const database = open(root);
    const records = await fixture();
    const preparation = database.recordAction(database.generation, { kind: "preparation", value: records.preparation });
    database.recordAction(database.generation, { kind: "dispatch_intent", value: { ...records.intent, preparationRecordId: preparation.recordId } });
    database.close();
    const restored = open(root).readAction("run-1", "action-1");
    expect(restored.attempts).toHaveLength(1);
    expect(restored.attempts[0]!.result).toBeNull();
    expect(restored.settlement).toBeNull();
  });

  it("rejects orphan, mismatched and post-settlement facts without publishing them", async () => {
    const database = open(directory());
    const records = await fixture();
    expect(() => database.recordAction(database.generation, { kind: "dispatch_intent", value: records.intent })).toThrow("execution_record_reference_invalid");
    const preparation = database.recordAction(database.generation, { kind: "preparation", value: records.preparation });
    expect(() => database.recordAction(database.generation, { kind: "dispatch_intent", value: {
      ...records.intent, preparationRecordId: preparation.recordId,
      request: { ...records.intent.request, invocation: { ...records.intent.request.invocation, payload: { path: "other-file" } } },
    } })).toThrow("execution_record_reference_invalid");
    expect(database.readAction("run-1", "action-1").attempts).toHaveLength(0);
    expect(() => database.recordAction(database.generation, { kind: "settlement", value: records.settlement })).toThrow("execution_record_reference_invalid");
    database.recordAction(database.generation, { kind: "settlement", value: {
      ...records.settlement, sandbox: null,
      settlement: { ...records.settlement.settlement, attempts: [], status: "invalidated", effectCertainty: "none", completionExtent: "none", payload: null },
    } });
    expect(() => database.recordAction(database.generation, { kind: "dispatch_intent", value: { ...records.intent, preparationRecordId: preparation.recordId } })).toThrow("execution_action_already_settled");
  });

  it("rejects corruption rather than treating retained execution as empty", async () => {
    const root = directory();
    const database = open(root);
    const records = await fixture();
    database.recordAction(database.generation, { kind: "preparation", value: records.preparation });
    database.close();
    const raw = new Database(join(root, "execution.sqlite"));
    raw.prepare("UPDATE action_records SET digest='changed'").run();
    raw.close();
    expect(() => open(root).readAction("run-1", "action-1")).toThrow("execution_records_corrupt");
  });

  it("uses OS exclusion and recovers committed facts after an abruptly killed owner", async () => {
    const root = directory();
    const records = await fixture();
    const module = pathToFileURL(join(process.cwd(), testBuild, "main/execution-storage/ExecutionDatabase.js")).href;
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { ExecutionDatabase } from ${JSON.stringify(module)};
      const database = new ExecutionDatabase(process.argv[1]);
      process.on('message', record => {
        const receipt = database.recordAction(database.generation, record);
        process.send({receipt, generation: database.generation});
      });
      process.send({ready: true});
    `, root], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let exited = false;
    child.once("exit", () => { exited = true; });
    const exit = once(child, "exit");
    try {
      await once(child, "message");
      const response = once(child, "message");
      child.send({ kind: "preparation", value: records.preparation });
      const [message] = await response as [{ receipt: { recordId: string }; generation: number }];
      expect(() => new ExecutionDatabase(root)).toThrow("execution_store_already_owned");
      child.kill();
      await exit;
      const database = open(root);
      expect(database.generation).toBe(message.generation + 1);
      expect(database.readReceipt(message.receipt.recordId)).not.toBeNull();
      expect(database.readAction("run-1", "action-1").preparations).toHaveLength(1);
    } finally {
      if (!exited) { child.kill(); await exit; }
    }
  }, 20_000);

  it("writes through one acknowledged Worker and closes after queued records", async () => {
    const root = directory();
    const store = await HelarcExecutionStore.open(root, compiledWorker);
    stores.push(store);
    const records = await fixture();
    const receipt = await store.recordPreEffect(records.preparation);
    expect(await store.readReceipt(receipt.recordId)).toEqual(receipt);
    const intent = await store.recordDispatchIntent({ ...records.intent, preparationRecordId: receipt.recordId });
    const result = store.recordAttemptResult({ ...records.result, intentRecordId: intent.recordId });
    await store.close();
    await expect(result).resolves.toHaveProperty("recordId");
    await expect(store.recordPostEffect(records.settlement)).rejects.toThrow("execution_store_closed");
    const reopened = open(root);
    expect(reopened.readAction("run-1", "action-1").attempts[0]!.result).not.toBeNull();
  });

  it("distinguishes a lost acknowledgement from a proven failed write", async () => {
    const root = directory();
    const worker = pathToFileURL(join(process.cwd(), "tests/fixtures/execution-storage-crash-worker.mjs"));
    const store = await HelarcExecutionStore.open(root, worker);
    stores.push(store);
    const records = await fixture();
    await expect(store.recordPreEffect(records.preparation)).rejects.toThrow("execution_storage_acknowledgement_unknown");
    await store.close().catch(() => {});
    const database = open(root);
    const retained = database.readAction("run-1", "action-1");
    expect(retained.preparations).toHaveLength(1);
    const receipt = database.recordAction(database.generation, { kind: "preparation", value: records.preparation });
    expect(receipt.recordId).toBe(retained.preparations[0]!.recordId);
    expect(receipt.generation).toBe(store.generation);
    expect(database.readAction("run-1", "action-1").preparations).toHaveLength(1);
  });

  it("bounds accepted pending writes and retains all admitted records on close", async () => {
    const root = directory();
    const store = await HelarcExecutionStore.open(root, compiledWorker);
    stores.push(store);
    const records = await fixture();
    const writes = Array.from({ length: EXECUTION_STORE_LIMITS.pendingRequests + 1 }, (_, index) =>
      store.recordPreEffect({ ...records.preparation, dispatchPlanFingerprint: `dispatch-plan-${index}` }));
    const settled = await Promise.allSettled(writes);
    expect(settled.filter(value => value.status === "fulfilled")).toHaveLength(EXECUTION_STORE_LIMITS.pendingRequests);
    expect(settled.at(-1)).toMatchObject({ status: "rejected", reason: { code: "execution_storage_capacity_exceeded" } });
    await store.close();
    expect(open(root).readAction("run-1", "action-1").preparations).toHaveLength(EXECUTION_STORE_LIMITS.pendingRequests);
  });

  it("does not admit another attempt while the previous attempt has no retained result", async () => {
    const database = open(directory());
    const records = await fixture();
    const preparation = database.recordAction(database.generation, { kind: "preparation", value: records.preparation });
    database.recordAction(database.generation, { kind: "dispatch_intent", value: { ...records.intent, preparationRecordId: preparation.recordId } });
    expect(() => database.recordAction(database.generation, { kind: "dispatch_intent", value: {
      ...records.intent, preparationRecordId: preparation.recordId,
      request: { ...records.intent.request, attempt: { ...records.intent.request.attempt, id: "attempt-2", ordinal: 2 } },
    } })).toThrow("execution_record_reference_invalid");
    expect(database.readAction("run-1", "action-1").attempts).toHaveLength(1);
  });
});

// Storage tests use opaque owner payloads; Runtime tests validate their semantics.
function recoveryCoordinator(store: HelarcExecutionStore, preparation: ActionPreparationRecord) {
  const {registrationFingerprint: _fingerprint, ...registration} = preparation.registration;
  const execute = vi.fn(async (): Promise<never> => {throw new Error("Recovery must not dispatch.");});
  const coordinator = new ActionExecutionCoordinator({
    registrations: createActionRegistrationSnapshot([registration]), records: store,
    adapters: [{adapter: {
      descriptor: registration.adapter,
      async prepare() {throw new Error("Recovery must not prepare replacement work.");},
      async revalidate() {return {status: "valid", recordId: "baseline"};},
      async settle(_prepared, settlement) {return {operationInvocationId: settlement.operationInvocation.id,
        settlement, status: settlement.status === "succeeded" ? "succeeded" : "failed", output: settlement.payload,
        failure: settlement.status === "succeeded" ? null : {owner: "test", code: "unknown", message: "Unknown outcome", retryable: false, metadata: {}}};},
    }}],
    policy: {async evaluate() {throw new Error("Recovery must not create new authority.");}},
    permission: {async assess() {throw new Error("Unexpected assessment.");}, async consumeActionCoverage() {throw new Error("Unexpected consumption.");}},
    approval: null, sandbox: {execute, async cancel() {return {status: "already_settled"};}},
    retry: {async decide() {throw new Error("Unexpected retry.");}, async wait() {return "elapsed";}},
    now: () => "2026-10-15T00:00:00.000Z",
  });
  const request = {
    action: {id: "action-1"}, runId: "run-1", parentRunAction: preparation.prepared.subject.parentRunAction,
    binding: preparation.binding,
    securityContext: {workspace: null, actor: preparation.prepared.subject.actor, environment: preparation.prepared.subject.environment},
    policyContext: {policySnapshotId: "policy-1", workspaceTrustState: "trusted" as const, identityId: "user", environmentId: "local", metadata: {}},
    permissionContext: () => ({authoritySnapshotId: "permission-1"} as never),
    enforcement: "disabled" as const, interruption: {signal: new AbortController().signal} as never,
    deadlineAt: "2026-10-13T01:00:00.000Z", maxAttempts: 1, isProgressionBasisCurrent: () => false,
    authority: {captureBasis: () => ({authorityRevision: "1", resourceRevision: 1}), isBasisCurrent: () => false},
  };
  return {coordinator, request, execute};
}

function runCommit(revision: number): RunCommit {
  const agent = {id: "agent-1", revision: "1"};
  const instructions = {ref: {id: "instructions-1", revision: "1"}};
  const instructionBinding = {ref: {id: "binding-1", revision: "1"}, agent, instructions: instructions.ref};
  return {
    id: `run-1:commit:${revision}`, expectedRevision: revision === 0 ? null : revision - 1,
    admission: revision === 0 ? {input: {task: {id: "task-1"}}, config: {}} : null,
    state: {run: {id: "run-1"}, taskId: "task-1", revision, status: "running", activeAgent: agent,
      activeInstructionBinding: instructionBinding.ref, startedAt: "2026-10-14T00:00:00Z", deadlineAt: "2026-10-14T01:00:00Z",
      items: revision === 0 ? [] : [{ref: {id: "item-1"}, committedInRevision: 1, payload: {kind: "test"}}]},
    control: {activeAgent: agent, instructionBinding, instructions, descendantTransfers: [], steering: {epoch: 0, pending: [], ledger: []}},
  } as unknown as RunCommit;
}

function treeCommit(revision: number, child = false): RunTreeCommit {
  const base = runCommit(revision);
  const root = {kind: "root" as const, root: {id: "run-1"}, depth: 0 as const};
  const descendant = {kind: "descendant" as const, root: {id: "run-1"}, parent: {id: "run-1"},
    parentRunAction: {id: "action-1", run: {id: "run-1"}, sequence: 1}, relation: {id: "relation-1"}, depth: 1};
  const dimensions = ["controllerTurns", "actions", "modelInputTokens", "modelOutputTokens", "costUnits", "contextBytes", "resultBytes"] as const;
  const amounts = (value: number) => Object.fromEntries(dimensions.map(dimension => [dimension, value]));
  const envelope = Object.fromEntries(dimensions.map(dimension => [dimension, {enforcement: "hard", maximum: 1000, minimumChildGrant: 1}]));
  const approvals = {maxTotalRequests: 20, maxRequestsPerOperationFingerprint: 4,
    maxConsecutiveDeclines: 3, maxConsecutiveReviewerFailures: 3, maxActiveReviews: 2};
  const lineages = child ? [root, descendant] : [root];
  const runs = lineages.map((lineage, index) => {
    const id = `run-${index + 1}`;
    const value = index === 0 ? base : runCommit(0);
    return {...value, id: `${id}:commit:${value.state.revision}`,
      state: {...value.state, run: {id}, completedAt: null, settlementCause: null,
        items: index === 0 && child ? [...value.state.items, {ref: {id: "delegation-item"},
          payload: {kind: "run_action", action: {ref: descendant.parentRunAction}}}] : value.state.items},
      admission: value.admission === null ? null : {...value.admission, lineage}};
  });
  return {
    id: `run-1:tree_commit:${revision}`, expectedRevision: revision === 0 ? null : revision - 1, revision, runs,
    checkpoint: {
      input: {rootRunId: "run-1", startedAt: base.state.startedAt, deadlineAt: base.state.deadlineAt,
        limits: {maxTotalDescendantRuns: 10, maxActiveDescendantRuns: 10, maxDescendantDepth: 3},
        resources: envelope, approvals, rootAuthorityRevision: "root-authority"},
      revision, cancellationRequestCount: 0, latestCancellation: null,
      nodes: lineages.map((lineage, index) => ({runId: `run-${index + 1}`, lineage,
        relationKind: index === 0 ? null : "delegation", acceptedOrder: index,
        dispatch: index === 0 ? null : {schemaVersion: 1, requestedForm: "single", controllerRequestId: "request-1",
          controllerTurnId: "turn-1", candidateIndex: 0, siblingIndex: 0, siblingCount: 1},
        status: "running", terminal: null, startedAt: base.state.startedAt, completedAt: null,
        admittedAuthorityRevision: index === 0 ? "root-authority" : "child-authority", authorityRevisionSequence: 0,
        cancellation: null, resultTransfer: index === 0 ? "not_required" : "pending"})),
      resources: {envelope, rootRunId: "run-1", measuredConsumed: amounts(0), chargedUnknown: amounts(0),
        cumulativeReleased: amounts(0), observed: amounts(0),
        nodes: lineages.map((_, index) => ({runId: `run-${index + 1}`, parentRunId: index === 0 ? null : "run-1",
          requestedAllocation: amounts(index === 0 ? 1000 : 100), hardGrant: amounts(index === 0 ? 1000 : 100),
          hardAvailable: amounts(index === 0 ? (child ? 900 : 1000) : 100),
          observationalThresholds: amounts(0), measured: amounts(0),
          measurementStatus: Object.fromEntries(dimensions.map(dimension => [dimension, "measured"])),
          settled: false, limitExceeded: false, revision: 0, settlement: null}))},
      approvals: {limits: approvals, active: [], seenRequestIds: [], operationCounts: [], revision: 0,
        totalRequests: 0, settledRequests: 0, consecutiveDeclines: 0, consecutiveReviewerFailures: 0},
    },
  } as unknown as RunTreeCommit;
}

async function fixture(maxAttempts = 1): Promise<{ preparation: ActionPreparationRecord; intent: ActionDispatchIntent; result: ActionAttemptResultRecord; settlement: ActionSettlementRecord }> {
  const now = "2026-10-13T00:00:00.000Z";
  const operation = { operation: { namespace: "test", name: "read" }, revision: "1" } as const;
  const binding = {
    kind: "direct" as const, invocation: { id: "invocation-1", operation },
    binding: { operation, revision: "1" }, parentInvocation: null,
    correlation: { kind: "run_action" as const, run: { id: "run-1" },
      runAction: { run: { id: "run-1" }, id: "run-action-1", sequence: 1 },
      provenance: { kind: "automatic" as const, trigger: { owner: "test", operationId: "test" } }, materializationRevision: 1 },
    request: { path: "/workspace/file" }, resolverRevision: "1", resolutionFingerprint: "binding-1", actionAdapterId: "test.adapter",
  };
  const registration = createActionRegistrationSnapshot([{
    registrationId: "test.registration", revision: "1", operation, binding: binding.binding,
    adapter: { id: "test.adapter", version: "1", requestSchemaRevision: "1" },
    executor: { id: "test.executor", version: "1", invocationContractVersion: "1", physicalPayloadSchemaRevision: "1" },
    effectFamilies: ["filesystem"], sandboxRequirementRevision: "1", executionLifetime: "invocation",
    maxInvocationBytes: 65536, maxPhysicalResultBytes: 65536,
  }]).registrations[0]!;
  const controller = new AbortController();
  const prepared = await createPreparedAction(binding, {
    action: { id: "action-1" }, parentRunAction: binding.correlation.runAction, subjectRevision: 1, registration, workspace: null,
    actor: createCanonicalActorIdentity({ identityId: "user", kind: "user" }),
    environment: createCanonicalEnvironmentIdentity({ environmentId: "local", platform: "posix", configurationFingerprint: `sha256:${"a".repeat(64)}` }),
    interruption: { signal: controller.signal, checkpoint: () => ({ status: "active" }), waitForInterruption: () => new Promise(() => {}) } as never,
    now: () => now,
  }, {
    effectSet: { kind: "effects", values: [{ kind: "file_system", operation: "read", targets: [{ platform: "posix", path: "/workspace/file", resolvedPath: "/workspace/file", workspaceRootId: null, resolutionFingerprint: `sha256:${"b".repeat(64)}` }] }] },
    requestedAuthority: null, targetAssertions: [], approval: null,
    safeSummary: { kind: "file_system", headline: "Read file", operations: [{ operation: "read", sourceLabel: "file", destinationLabel: null }] },
    preparedInvocation: { contractVersion: "1", executorId: "test.executor", executorVersion: "1", payload: binding.request },
    semanticBasis: { path: "/workspace/file" }, replayBasis: maxAttempts > 1 ? "confirmed_no_effect" : "none",
  });
  const preparation: ActionPreparationRecord = {
    runId: "run-1", prepared, binding, registration, dispatchPlanFingerprint: "dispatch-plan-1", recordedAt: now,
    limits: {maxAttempts, deadlineAt: "2026-10-13T01:00:00.000Z"},
    policy: { status: "allowed", owner: "governance", subject: prepared.subject.ref, checkId: "policy-check", recordId: "policy-record", revision: "policy-1", code: null, reason: null, decidedAt: now },
    permission: { status: "authorized", owner: "permission", subject: prepared.subject.ref, recordId: "permission-record", revision: "permission-1", authorityCoverageDigest: "authority-1", actionCoverageId: null, assessedAt: now },
  };
  const attempt = { action: { id: "action-1" }, id: "attempt-1", ordinal: 1, runId: "run-1",
    actionFingerprint: "action-fingerprint", enforcement: "disabled" as const, policyId: "policy-1", authoritySnapshotId: "permission-1",
    dispatchPlanFingerprint: "dispatch-plan-1", actionRegistrationFingerprint: registration.registrationFingerprint, startedAt: now };
  const ledger = new CanonicalActionLedger(attempt.action, binding.correlation.runAction);
  await ledger.transition({expectedRevision: 0, kind: "begin_preparation"});
  await ledger.transition({expectedRevision: 1, kind: "record_subject", subject: prepared.subject});
  for (const kind of ["begin_assessment", "mark_ready", "begin_revalidation"] as const) {
    await ledger.transition({expectedRevision: ledger.getSnapshot().revision, kind});
  }
  await ledger.claimDispatch({expectedRevision: ledger.getSnapshot().revision, claimId: "claim-1",
    attemptId: attempt.id, planFingerprint: "dispatch-plan-1", claimedAt: now});
  const intent: ActionDispatchIntent = { preparationRecordId: "not-recorded", ledger: ledger.getSnapshot(), request: {
    attempt, executionLifetime: "invocation", executor: registration.executor, actionRegistrationFingerprint: registration.registrationFingerprint,
    invocation: prepared.invocation, deadlineAt: "2026-10-13T01:00:00.000Z",
    policy: { schemaVersion: 1, policyId: "policy-1", actionFingerprint: "action-fingerprint", authoritySnapshotId: "permission-1", enforcement: "disabled", defaultDisposition: "deny", effectFamilies: ["filesystem"], resourceLimits: { maxResultBytes: 65536 }, allowedSecretReferences: [] },
  } };
  const result: ActionAttemptResultRecord = { intentRecordId: "not-recorded", recordedAt: now, result: {
    status: "settled", attempt, outcome: { status: "completed", effectState: "settled", payload: { content: "hello" } }, isolation: "unisolated",
    enforcementEvidence: { providerId: "local", providerVersion: "1", policyId: "policy-1", enforcement: "disabled", enforcedEffectFamilies: [], settledAt: now },
  } };
  const settlement: ActionSettlementRecord = { runId: "run-1", binding, prepared, sandbox: result.result, settlement: {
    ref: { action: { id: "action-1" }, id: "settlement-1" }, action: { id: "action-1" }, subject: prepared.subject.ref,
    operationInvocation: binding.invocation, binding: binding.binding, status: "succeeded", attempts: [{ action: attempt.action, id: attempt.id, ordinal: 1 }],
    effectCertainty: "confirmed", completionExtent: "complete", payload: { content: "hello" }, causeOwner: null, causeRef: null, reconciliationRequired: false, settledAt: now,
  } };
  return { preparation, intent, result, settlement };
}

import { describe, expect, it, vi } from "vitest";
import type { RunCommit } from "./RunCommitPort.js";
import { RunCommitError } from "./RunCommitPort.js";
import type { RunTreeCommitPort, RunTreeRecoveryRecords } from "./RunTreeCommitPort.js";
import { RunTreeCommitWriter } from "./RunTreeCommitWriter.js";
import { RunTreeExecution } from "./RunTreeExecution.js";
import { runTreeResourceDimensions } from "./RunTreeResourceAccount.js";

const now = () => "2026-10-15T01:00:00.000Z";

function fixture() {
  const tree = new RunTreeExecution({rootRunId: "root", startedAt: now(), deadlineAt: "2026-10-15T02:00:00.000Z", now,
    limits: {maxTotalDescendantRuns: 10, maxActiveDescendantRuns: 10, maxDescendantDepth: 3}, rootAuthorityRevision: "authority-1",
    resources: Object.fromEntries(runTreeResourceDimensions.map(key => [key, {enforcement: "hard", maximum: 1000, minimumChildGrant: 1}])) as never,
    approvals: {maxTotalRequests: 20, maxRequestsPerOperationFingerprint: 4,
      maxConsecutiveDeclines: 3, maxConsecutiveReviewerFailures: 3, maxActiveReviews: 2}});
  const agent = {id: "agent", revision: "1"};
  const instructions = {ref: {id: "instructions", revision: "1"}};
  const binding = {ref: {id: "binding", revision: "1"}, agent, instructions: instructions.ref};
  const root = {
    id: "root:commit:0", expectedRevision: null,
    admission: {lineage: tree.rootLineage, input: {task: {id: "task"}}, config: {}},
    state: {run: {id: "root"}, taskId: "task", activeAgent: agent, activeInstructionBinding: binding.ref,
      revision: 0, items: [], status: "initializing", startedAt: now(), deadlineAt: "2026-10-15T02:00:00.000Z",
      completedAt: null, settlementCause: null},
    control: {activeAgent: agent, instructionBinding: binding, instructions, descendantTransfers: []},
  } as unknown as RunCommit;
  let records: RunTreeRecoveryRecords | null = null;
  const port: RunTreeCommitPort = {
    commitRunTree: vi.fn(async commit => {
      const members = new Map((records?.members ?? []).map(member => [member.head.state.run.id, member]));
      for (const head of commit.runs) members.set(head.state.run.id, {head,
        admission: members.get(head.state.run.id)?.admission ?? head.admission!});
      records = structuredClone({commit, members: [...members.values()]});
      return {recordId: commit.id, revision: commit.revision,
        runs: commit.runs.map(head => ({recordId: head.id, revision: head.state.revision}))};
    }),
    readRunTree: vi.fn(async () => structuredClone(records)),
    readRunTreeCommit: vi.fn(async id => records?.commit.id === id ? structuredClone(records.commit) : null),
  };
  return {tree, root, port, writer: new RunTreeCommitWriter(tree.checkpoint(), port, now)};
}

function next(before: RunCommit, status: RunCommit["state"]["status"]): RunCommit {
  const revision = before.state.revision + 1;
  return {...before, id: `${before.state.run.id}:commit:${revision}`, expectedRevision: before.state.revision,
    admission: null, state: {...before.state, revision, status}};
}

describe("Run Tree coordinated state writer", () => {
  it("prepares the next transition from acknowledged state and publishes the whole basis together", async () => {
    const {writer, port, root} = fixture();
    await writer.transaction(() => ({runs: [root], value: undefined}));
    let entered!: () => void;
    let release!: () => void;
    const entering = new Promise<void>(resolve => {entered = resolve;});
    const held = new Promise<void>(resolve => {release = resolve;});
    const actual = port.commitRunTree;
    port.commitRunTree = vi.fn(async commit => {if (commit.revision === 1) {entered(); await held;} return actual(commit);});
    const published = vi.fn();
    writer.subscribe(published);
    const seen: number[] = [];
    const change = (status: "running" | "waiting") => writer.transaction(({tree, members}) => {
      seen.push(members[0]!.head.state.revision);
      tree.updateLifecycle("root", status);
      tree.recordResources("root", {controllerTurns: {status: "measured", value: 1}});
      return {runs: [next(members[0]!.head, status)], value: status};
    });
    const running = change("running");
    const waiting = change("waiting");
    await entering;
    expect(seen).toEqual([0]);
    expect(writer.getSnapshot()?.commit.revision).toBe(0);
    expect(published).toHaveBeenCalledOnce();
    release();
    expect(await running).toBe("running");
    expect(await waiting).toBe("waiting");
    expect(seen).toEqual([0, 1]);
    expect(writer.getSnapshot()?.members[0]?.head.state).toMatchObject({revision: 2, status: "waiting"});
    expect(writer.getSnapshot()?.commit.checkpoint.resources.nodes[0]?.measured.controllerTurns).toBe(2);
    expect(published).toHaveBeenCalledTimes(3);
  });

  it("does not publish rejected drafts and allows another valid local proposal", async () => {
    const {writer, port, root} = fixture();
    await writer.transaction(() => ({runs: [root], value: undefined}));
    await expect(writer.transaction(({tree}) => {
      tree.updateLifecycle("root", "waiting");
      return {runs: [], value: undefined};
    })).rejects.toThrow("Run lifecycle");
    expect(port.commitRunTree).toHaveBeenCalledOnce();
    expect(writer.getSnapshot()?.commit.revision).toBe(0);
    await writer.transaction(({tree, members}) => {
      tree.updateLifecycle("root", "running");
      return {runs: [next(members[0]!.head, "running")], value: undefined};
    });
    expect(writer.getSnapshot()?.commit.revision).toBe(1);
  });

  it("closes on unknown acknowledgement, retains commit identity, and recovers without replaying preparation", async () => {
    const {writer, port, root} = fixture();
    const actual = port.commitRunTree;
    port.commitRunTree = vi.fn(async commit => {await actual(commit); throw new Error("ack lost");});
    const prepare = vi.fn(() => ({runs: [root], value: undefined}));
    const queued = vi.fn(() => ({runs: [], value: undefined}));
    const first = writer.transaction(prepare);
    const second = writer.transaction(queued);
    await expect(first).rejects.toBeInstanceOf(RunCommitError);
    await expect(second).rejects.toBeInstanceOf(RunCommitError);
    expect(prepare).toHaveBeenCalledOnce();
    expect(queued).not.toHaveBeenCalled();
    expect(writer.getSnapshot()).toBeNull();
    expect(writer.getUnconfirmedCommit()?.id).toBe("root:tree_commit:0");
    const recovered = await RunTreeCommitWriter.recover("root", port, now);
    expect(recovered?.getSnapshot()?.members[0]?.head).toEqual(root);
    expect(port.readRunTree).toHaveBeenCalledOnce();
    expect(port.readRunTreeCommit).not.toHaveBeenCalled();
    expect(port.commitRunTree).toHaveBeenCalledOnce();
  });

  it("rejects a mismatched receipt, and escaped draft references cannot change the frozen attempt", async () => {
    const {writer, port, root} = fixture();
    let escaped!: RunTreeExecution;
    port.commitRunTree = vi.fn(async commit => {
      escaped.updateLifecycle("root", "waiting");
      (commit as {revision: number}).revision = 900;
      return {recordId: "wrong", revision: 0, runs: []};
    });
    await expect(writer.transaction(({tree}) => {escaped = tree; return {runs: [root], value: undefined};})).rejects.toBeInstanceOf(RunCommitError);
    expect(writer.getUnconfirmedCommit()?.revision).toBe(0);
    expect(writer.getUnconfirmedCommit()?.checkpoint.nodes[0]?.status).toBe("initializing");
    expect(writer.getSnapshot()).toBeNull();
  });

  it("records a tree-only resource or authority change without inventing a Run revision", async () => {
    const {writer, root, port} = fixture();
    await writer.transaction(() => ({runs: [root], value: undefined}));
    await writer.transaction(({tree}) => {
      tree.recordResources("root", {contextBytes: {status: "measured", value: 20}});
      tree.advanceAuthorityRevision("root");
      return {runs: [], value: undefined};
    });
    expect(writer.getSnapshot()?.commit.checkpoint.revision).toBeGreaterThan(0);
    expect(writer.getSnapshot()?.members[0]?.head.state.revision).toBe(0);
    const recovered = await RunTreeCommitWriter.recover("root", port, now);
    expect(recovered?.getSnapshot()).toEqual(writer.getSnapshot());
  });

  it("rejects stale Run revisions, changed history and asynchronous preparation before persistence", async () => {
    const {writer, root, port} = fixture();
    await writer.transaction(() => ({runs: [root], value: undefined}));
    await expect(writer.transaction(() => ({runs: [root], value: undefined}))).rejects.toThrow("admission or revision");
    await expect(writer.transaction(() => ({runs: [{...next(root, "initializing"),
      state: {...next(root, "initializing").state, taskId: "changed"}}], value: undefined}))).rejects.toThrow("retained execution facts");
    await expect(writer.transaction((async () => ({runs: [], value: undefined})) as never)).rejects.toThrow("synchronous");
    expect(port.commitRunTree).toHaveBeenCalledOnce();
  });
});

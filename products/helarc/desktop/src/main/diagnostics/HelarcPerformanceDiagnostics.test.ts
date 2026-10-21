import {afterEach, expect, it} from "vitest";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {HelarcPerformanceDiagnostics} from "./HelarcPerformanceDiagnostics.js";
import {beginExecutionTiming, measureExecutionAsync, measureExecutionSync} from "./ExecutionPerformance.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, {recursive: true, force: true});
});
async function location(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "helarc-performance-"));
  directories.push(directory);
  return join(directory, "execution-performance.json");
}

it("records bounded, correlated timing evidence without request bodies or credentials", async () => {
  const path = await location(), diagnostics = new HelarcPerformanceDiagnostics(path);
  const sink = {performance: diagnostics.record.bind(diagnostics)};
  const end = beginExecutionTiming(sink, "storage.host.request", {runId: "run", requestId: 3,
    prompt: "private-prompt", environment: "private-environment", credential: "private-credential"});
  await diagnostics.flush();
  expect(JSON.parse(await readFile(path, "utf8")).active).toMatchObject([{context: {runId: "run", requestId: 3}}]);
  end(); end();
  for (let index = 0; index < 100; index++) {
    diagnostics.record({id: `timing-${index}`, kind: "finished", stage: "storage.worker.dispatch",
      occurredAt: new Date().toISOString(), context: {command: "commit_owner"}, durationMs: index, outcome: "ok"});
  }
  await diagnostics.flush();
  const text = await readFile(path, "utf8"), report = JSON.parse(text);
  expect(report.active).toEqual([]);
  expect(report.recent).toHaveLength(64);
  expect(report.slowest).toHaveLength(32);
  expect(report.totals["storage.host.request:"].count).toBe(1);
  expect(report.totals["storage.worker.dispatch:commit_owner"]).toMatchObject({count: 100, totalMs: 4950, maxMs: 99});
  expect(report.evicted).toBeGreaterThan(0);
  for (const secret of ["private-prompt", "private-environment", "private-credential"]) expect(text).not.toContain(secret);
});

it("persists active work and process resource samples periodically without a completed request", async () => {
  const path = await location(), diagnostics = new HelarcPerformanceDiagnostics(path);
  const end = beginExecutionTiming({performance: diagnostics.record.bind(diagnostics)}, "storage.host.request", {requestId: 1});
  try {
    await new Promise(resolve => setTimeout(resolve, 2300));
    const report = JSON.parse(await readFile(path, "utf8"));
    expect(report.active).toHaveLength(1);
    expect(report.resources[0]).toMatchObject({processCpuMs: expect.any(Number), processRssBytes: expect.any(Number),
      hostEventLoopUtilization: expect.any(Number), timerLagMs: expect.any(Number)});
  } finally {end(); await diagnostics.flush();}
});

it("keeps work counters separate from durations and excludes unknown/sensitive counter names", async () => {
  const path = await location(), diagnostics = new HelarcPerformanceDiagnostics(path);
  const end = beginExecutionTiming({performance: diagnostics.record.bind(diagnostics)}, "storage.worker.command", {command: "commit_run_tree"});
  end("ok", {"encode.nodes": 20, "encode.reusedBytes": 1000, "private-prompt": 1, "decode.nodes": -1});
  await diagnostics.flush();
  const text = await readFile(path, "utf8"), report = JSON.parse(text);
  expect(report.counters["storage.worker.command:commit_run_tree:encode.reusedBytes"]).toEqual({reports: 1, total: 1000, max: 1000});
  expect(report.recent[0].counters).toEqual({"encode.nodes": 20, "encode.reusedBytes": 1000});
  expect(report.totals["storage.worker.command:commit_run_tree"].count).toBe(1);
  expect(text).not.toContain("private-prompt");
});

it("retains one preceding session instead of erasing restart evidence", async () => {
  const path = await location();
  for (let session = 0; session < 3; session++) {
    const diagnostics = new HelarcPerformanceDiagnostics(path);
    beginExecutionTiming({performance: diagnostics.record.bind(diagnostics)}, `session.${session}`, {})();
    await diagnostics.flush();
  }
  const current = JSON.parse(await readFile(path, "utf8"));
  const previous = JSON.parse(await readFile(join(path, "..", "execution-performance.previous.json"), "utf8"));
  expect(current.recent[0].stage).toBe("session.2");
  expect(previous.recent[0].stage).toBe("session.1");
  expect(previous.sessionId).not.toBe(current.sessionId);
});
it("cannot replace execution results, exceptions, or acknowledgement when observation fails", async () => {
  const sink = {performance() {throw new Error("observer unavailable");}};
  expect(measureExecutionSync(sink, "test", {}, () => 42)).toBe(42);
  const original = new Error("original");
  expect(() => measureExecutionSync(sink, "test", {}, () => {throw original;})).toThrow(original);
  await expect(measureExecutionAsync(sink, "test", {}, async () => {throw original;})).rejects.toBe(original);
  const path = await location();
  await writeFile(path, "not a directory");
  const diagnostics = new HelarcPerformanceDiagnostics(join(path, "child.json"));
  beginExecutionTiming({performance: diagnostics.record.bind(diagnostics)}, "test", {})();
  await expect(diagnostics.flush()).resolves.toBeUndefined();
});

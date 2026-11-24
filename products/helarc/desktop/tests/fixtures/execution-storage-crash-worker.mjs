import { parentPort, workerData } from "node:worker_threads";
const diagnostics = process.env.HELARC_TEST_STORAGE_TIMINGS === "1";
let previous = diagnostics ? performance.now() : 0;
let cpu = diagnostics ? process.threadCpuUsage() : null;
const mark = phase => {
  if (!diagnostics) return;
  const now = performance.now(), current = process.threadCpuUsage();
  console.info("Crash Worker diagnostic", JSON.stringify({
    phase, at: Date.now(), ms: now - previous,
    cpuUserMs: (current.user - cpu.user) / 1000,
    cpuSystemMs: (current.system - cpu.system) / 1000,
    pid: process.pid, execArgv: process.execArgv,
  }));
  previous = now; cpu = current;
};
mark("entry");
const { ExecutionDatabase } = await import(new URL(`../../${process.env.HELARC_EXECUTION_TEST_BUILD ?? "dist"}/main/execution-storage/ExecutionDatabase.js`, import.meta.url));
mark("database_imported");

const database = new ExecutionDatabase(workerData.directory);
mark("database_opened");
parentPort.postMessage({ kind: "ready", generation: database.generation });
parentPort.on("message", request => {
  if (request.command.kind === "discover_product_work") {
    parentPort.postMessage({kind: "result", id: request.id, value: database.discoverProductWork(request.command.delivery)});
    return;
  }
  if (request.command.kind === "list_product_runs") {
    parentPort.postMessage({kind: "result", id: request.id, value: database.listProductRuns()});
    return;
  }
  if (request.command.kind === "commit_run_tree") database.commitRunTree(request.generation, request.command.commit);
  else if (request.command.kind === "commit_owner") database.commitOwner(request.generation, request.command.commit);
  else if (request.command.kind === "record_action") database.recordAction(request.generation, request.command.record);
  else throw new Error("Unexpected crash-worker command: " + request.command.kind);
  mark("commit_completed");
  // Deliberately lose the acknowledgement after SQLite has committed.
  process.exit(0);
});

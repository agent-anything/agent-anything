import { parentPort, workerData } from "node:worker_threads";
const { ExecutionDatabase } = await import(new URL(`../../${process.env.HELARC_EXECUTION_TEST_BUILD ?? "dist"}/main/execution-storage/ExecutionDatabase.js`, import.meta.url));

const database = new ExecutionDatabase(workerData.directory);
parentPort.postMessage({ kind: "ready", generation: database.generation });
parentPort.on("message", request => {
  if (request.command.kind === "list_product_runs") {
    parentPort.postMessage({kind: "result", id: request.id, value: database.listProductRuns()});
    return;
  }
  if (request.command.kind === "commit_run_tree") database.commitRunTree(request.generation, request.command.commit);
  else if (request.command.kind === "commit_owner") database.commitOwner(request.generation, request.command.commit);
  else database.recordAction(request.generation, request.command.record);
  // Deliberately lose the acknowledgement after SQLite has committed.
  process.exit(0);
});

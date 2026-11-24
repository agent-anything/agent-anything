import {parentPort} from "node:worker_threads";

parentPort.on("message", request => {
  if (request.command.kind === "list_product_runs" || request.command.kind === "discover_product_work") {
    parentPort.postMessage({kind: "result", id: request.id, value: []});
  } else if (request.command.kind !== "commit_run_tree") throw new Error("Unexpected unresponsive-worker command: " + request.command.kind);
});
parentPort.postMessage({kind: "ready", generation: 1});

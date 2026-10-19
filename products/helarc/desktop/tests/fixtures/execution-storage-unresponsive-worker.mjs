import {parentPort} from "node:worker_threads";

parentPort.on("message", request => {
  if (request.command.kind === "list_product_runs") {
    parentPort.postMessage({kind: "result", id: request.id, value: []});
  }
});
parentPort.postMessage({kind: "ready", generation: 1});

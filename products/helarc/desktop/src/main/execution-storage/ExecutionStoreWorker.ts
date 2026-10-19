import { parentPort, workerData } from "node:worker_threads";
import { ExecutionDatabase } from "./ExecutionDatabase.js";
import { ExecutionStoreError, type ExecutionStoreCommand, type ExecutionStoreRequest, type ExecutionStoreReply } from "./ExecutionStoreProtocol.js";
import {EXECUTION_CONTENT_LIMITS} from "./ExecutionContent.js";
import { captureExecutionError } from "../diagnostics/ExecutionErrorDetails.js";

if (!parentPort) throw new Error("Execution storage requires its dedicated Worker.");
const port = parentPort;
let database: ExecutionDatabase;
try {
  database = new ExecutionDatabase((workerData as { directory: string }).directory);
  send({ kind: "ready", generation: database.generation });
  port.on("message", (wire: ExecutionStoreRequest) => {
    try {
      if (wire.generation !== database.generation) throw new ExecutionStoreError("execution_owner_stale");
      if (wire.command.kind === "stage_content") {
        database.stageContent(wire.generation, wire.command.blocks);
        send({kind: "content_staged", id: wire.id}); return;
      }
      if (wire.command.kind === "read_content") {
        if (wire.command.ids.length > 16) throw new ExecutionStoreError("execution_content_transfer_too_large");
        send({kind: "content_blocks", id: wire.id, blocks: wire.command.ids.map(id => database.readContentBlock(id))}); return;
      }
      const command = wire.command.kind === "invoke_content" ? database.hydrateContent(wire.command.root) as ExecutionStoreCommand : wire.command;
      const request = {...wire, command};
      switch (request.command.kind) {
        case "file_material": send({kind: "result", id: request.id, value: database.fileMaterialCommand(request.generation, request.command.command)}); break;
        case "commit_reference_transfer": database.commitReferenceTransfer(request.generation, request.command.transfer); send({kind: "result", id: request.id, value: null}); break;
        case "read_reference_transfers": send({kind: "result", id: request.id, value: database.readReferenceTransfers(request.command.runId)}); break;
        case "read_run_execution_refs": send({kind: "result", id: request.id, value: database.readRunExecutionRefs(request.command.runId, request.command.after, request.command.limit)}); break;
        case "finalize_file_materials": send({kind: "result", id: request.id, value: database.finalizeFileMaterials(request.generation, request.command.rootRunId, request.command.after, request.command.at)}); break;
        case "commit_execution_evidence": database.commitExecutionEvidence(request.generation, request.command.record); send({kind: "result", id: request.id, value: null}); break;
        case "read_execution_evidence": send({kind: "result", id: request.id, value: database.readExecutionEvidence(request.command.reference)}); break;
        case "commit_compensation_association": database.commitCompensationAssociation(request.generation, request.command.association); send({kind: "result", id: request.id, value: null}); break;
        case "read_compensation_association": send({kind: "result", id: request.id, value: database.readCompensationAssociation(request.command.invocationId)}); break;
        case "admit_product_run": database.admitProductRun(request.generation, request.command.admission); send({kind: "result", id: request.id, value: null}); break;
        case "read_product_run": send({kind: "result", id: request.id, value: database.readProductRun(request.command.rootRunId)}); break;
        case "list_product_runs": send({kind: "result", id: request.id, value: database.listProductRuns()}); break;
        case "list_retention_pins": send({kind: "result", id: request.id, value: database.listRetentionPins()}); break;
        case "commit_product_delivery": database.commitProductDelivery(request.generation, request.command.rootRunId); send({kind: "result", id: request.id, value: null}); break;
        case "commit_shell_session": database.commitShellSession(request.generation, request.command.commit); send({kind: "result", id: request.id, value: null}); break;
        case "read_shell_session": send({kind: "result", id: request.id, value: database.readShellSession(request.command.runId)}); break;
        case "commit_process": database.commitProcess(request.generation, request.command.checkpoint); send({kind: "result", id: request.id, value: null}); break;
        case "read_processes": send({kind: "result", id: request.id, value: database.readProcesses(request.command.runId)}); break;
        case "commit_hook": database.commitHookInvocation(request.generation, request.command.checkpoint); send({kind: "result", id: request.id, value: null}); break;
        case "read_hook": send({kind: "result", id: request.id, value: database.readHookInvocation(request.command.id)}); break;
        case "list_unsettled_hooks": send({kind: "result", id: request.id, value: database.listUnsettledHooks()}); break;
        case "commit_run_tree": send({kind: "result", id: request.id, value: database.commitRunTree(request.generation, request.command.commit)}); break;
        case "read_run_tree_commit": send({kind: "result", id: request.id, value: database.readRunTreeCommit(request.command.recordId)}); break;
        case "read_run_tree_latest": send({kind: "result", id: request.id, value: database.readLatestRunTree(request.command.rootRunId)}); break;
        case "read_run_tree": send({kind: "result", id: request.id, value: database.readRunTree(request.command.rootRunId)}); break;
        case "commit_owner": send({kind: "result", id: request.id, value: database.commitOwner(request.generation, request.command.commit)}); break;
        case "read_owner_commit": send({kind: "result", id: request.id, value: database.readOwnerCommit(request.command.recordId)}); break;
        case "read_owner_latest": send({kind: "result", id: request.id, value: database.readLatestOwner(request.command.owner, request.command.ownerId)}); break;
        case "record_action": send({ kind: "result", id: request.id, value: database.recordAction(request.generation, request.command.record) }); break;
        case "read_action": send({ kind: "result", id: request.id, value: database.readAction(request.command.runId, request.command.actionId) }); break;
        case "read_receipt": send({ kind: "result", id: request.id, value: database.readReceipt(request.command.recordId) }); break;
        case "close": database.close(); send({ kind: "result", id: request.id, value: null }); port.close(); break;
        default: throw new ExecutionStoreError("execution_storage_protocol_invalid");
      }
    } catch (error) {
      send({ kind: "rejected", id: wire.id, code: code(error), error: captureExecutionError(error) });
    }
  });
  port.on("close", () => database.close());
} catch (error) {
  send({ kind: "startup_failed", code: code(error), error: captureExecutionError(error) });
  port.close();
}

function send(reply: ExecutionStoreReply): void {
  if (reply.kind === "result" && Buffer.byteLength(JSON.stringify(reply.value)) > EXECUTION_CONTENT_LIMITS.blockBytes) {
    port.postMessage({kind: "content_result", id: reply.id, root: database.retainContent(reply.value)} satisfies ExecutionStoreReply);
  } else port.postMessage(reply);
}
function code(error: unknown): string {
  return error instanceof ExecutionStoreError || error instanceof Error && "code" in error && typeof error.code === "string" ? error.code as string : "execution_storage_failed";
}

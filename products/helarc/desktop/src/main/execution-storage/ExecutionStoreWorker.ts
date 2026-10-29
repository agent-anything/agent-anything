import { parentPort, workerData, threadId } from "node:worker_threads";
import {randomUUID} from "node:crypto";
import { ExecutionDatabase } from "./ExecutionDatabase.js";
import { ExecutionStoreError, type ExecutionStoreCommand, type ExecutionStoreRequest, type ExecutionStoreReply } from "./ExecutionStoreProtocol.js";
import {EXECUTION_CONTENT_LIMITS} from "./ExecutionContent.js";
import { captureExecutionError } from "../diagnostics/ExecutionErrorDetails.js";
import {beginExecutionTiming, measureExecutionSync, type ExecutionPerformanceSink} from "../diagnostics/ExecutionPerformance.js";

if (!parentPort) throw new Error("Execution storage requires its dedicated Worker.");
const port = parentPort;
const timingSink: ExecutionPerformanceSink | undefined = workerData.performanceDiagnostics
  ? {performance: event => {try {port.postMessage({kind: "performance", event} satisfies ExecutionStoreReply);} catch { /* Best effort only. */ }}}
  : undefined;
let timingContext: Record<string, string | number> = {};
let database: ExecutionDatabase;
try {
  database = new ExecutionDatabase((workerData as { directory: string }).directory, Boolean(timingSink));
  send({ kind: "ready", generation: database.generation });
  port.on("message", (wire: ExecutionStoreRequest) => {
    database.withContentScope(() => {
    timingContext = {requestId: wire.id, generation: wire.generation, wireKind: wire.command.kind, workerThreadId: threadId};
    const end = beginExecutionTiming(timingSink, "storage.worker.command", timingContext);
    let failed = false, close = false;
    try {
      if (wire.generation !== database.generation) throw new ExecutionStoreError("execution_owner_stale");
      if (wire.command.kind === "stage_content") {
        const blocks = wire.command.blocks;
        measureExecutionSync(timingSink, "storage.worker.stage_content", timingContext, () => database.stageContent(wire.generation, blocks));
        send({kind: "content_staged", id: wire.id}); return;
      }
      if (wire.command.kind === "read_content") {
        if (wire.command.ids.length > 16) throw new ExecutionStoreError("execution_content_transfer_too_large");
        send({kind: "content_blocks", id: wire.id, blocks: wire.command.ids.map(id => database.readContentBlock(id))}); return;
      }
      const wireCommand = wire.command;
      const command = wireCommand.kind === "invoke_content"
        ? measureExecutionSync(timingSink, "storage.worker.hydrate_command", timingContext, () => database.hydrateContent(wireCommand.root)) as ExecutionStoreCommand : wireCommand;
      timingContext.command = command.kind;
      const request = {...wire, command};
      const endDispatch = beginExecutionTiming(timingSink, "storage.worker.dispatch", timingContext);
      try {
      switch (request.command.kind) {
        case "accept_shared": send({kind:"result",id:request.id,value:database.acceptShared(request.generation,request.command.proposal)});break;
        case "material_custody": send({kind:"result",id:request.id,value:database.materialCustodyCommand(request.generation,request.command.command)});break;
        case "representation": send({kind:"result",id:request.id,value:database.representationCommand(request.generation,request.command.command)});break;
        case "context_selection": send({kind:"result",id:request.id,value:database.selectionCommand(request.generation,request.command.command)});break;
        case "context_policy": send({kind:"result",id:request.id,value:database.contextPolicyQuery(request.generation,request.command.query)});break;
        case "context_policy_investments": send({kind:"result",id:request.id,value:database.contextPolicyInvestments(request.generation,request.command.input)});break;
        case "context_foundation_facts": send({kind:"result",id:request.id,value:database.contextFoundationFacts(request.command.runId,request.command.after,request.command.limit)});break;
        case "query_acceptance": send({kind:"result",id:request.id,value:{acceptanceValue:database.querySharedAcceptance(request.generation,request.command.id)}}); break;
        case "activity_handoff": send({kind: "result", id: request.id, value: database.activityHandoffCommand(request.generation, request.command.command)}); break;
        case "register_recording": send({kind: "result", id: request.id, value: database.registerRecording(request.generation, request.command.recording)}); break;
        case "context_preparation": send({kind: "result", id: request.id, value: database.contextPreparationCommand(request.generation, request.command.command)}); break;
        case "context_material": send({kind: "result", id: request.id, value: database.contextMaterialCommand(request.generation, request.command.command)}); break;
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
        case "close": database.close(); send({ kind: "result", id: request.id, value: null }); close = true; break;
        default: throw new ExecutionStoreError("execution_storage_protocol_invalid");
      }
      endDispatch();
      } catch (error) {endDispatch("failed"); throw error;}
    } catch (error) {
      failed = true;
      send({ kind: "rejected", id: wire.id, code: code(error), error: captureExecutionError(error) });
    } finally {
      try {
        for (const fact of database.takeActivityObservations()) port.postMessage({kind:"activity_observation",fact} satisfies ExecutionStoreReply);
      } catch { /* Independent export; durable facts remain queryable. */ }
      try {
        for(const fact of database.takeContextFoundationObservations())port.postMessage({kind:"context_foundation_observation",fact} satisfies ExecutionStoreReply);
      } catch { /* Independent export; recovery can replay committed domain facts. */ }
      for (const observation of database.takeContextMaterialObservations()) if (!failed) {
        try {port.postMessage({kind: "context_material_observation", observation} satisfies ExecutionStoreReply);} catch { /* Independent observation. */ }
      }
      if (timingSink) {
        for (const sample of database.takePerformance()) timingSink.performance?.({kind: "finished", id: randomUUID(),
          stage: `storage.worker.${sample.stage}`, occurredAt: new Date().toISOString(), durationMs: sample.totalMs,
          outcome: failed ? "failed" : "ok", context: {...timingContext, count: sample.count, totalMs: sample.totalMs, maxMs: sample.maxMs}});
      }
      end(failed ? "failed" : "ok", database.takeContentStatistics());
      if (close) port.close();
    }
    });
  });
  port.on("close", () => database.close());
} catch (error) {
  send({ kind: "startup_failed", code: code(error), error: captureExecutionError(error) });
  port.close();
}

function send(reply: ExecutionStoreReply): void {
  if (reply.kind === "ready" || reply.kind === "startup_failed") {port.postMessage(reply); return;}
  measureExecutionSync(timingSink, "storage.worker.encode_reply", timingContext, () => {
    if (reply.kind === "result" && Buffer.byteLength(JSON.stringify(reply.value)) > EXECUTION_CONTENT_LIMITS.blockBytes) {
      port.postMessage({kind: "content_result", id: reply.id, root: database.retainContent(reply.value)} satisfies ExecutionStoreReply);
    } else port.postMessage(reply);
  });
}
function code(error: unknown): string {
  return error instanceof ExecutionStoreError || error instanceof Error && "code" in error && typeof error.code === "string" ? error.code as string : "execution_storage_failed";
}

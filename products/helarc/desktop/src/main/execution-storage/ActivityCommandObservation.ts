import type {ActivityHandoffCommand} from "@agent-anything/agent-runtime/activity";
import type {PerformanceContext} from "../diagnostics/ExecutionPerformance.js";

/** Original command identities only; this does not inspect professional input or infer progress. */
export function activityCommandObservation(command:ActivityHandoffCommand):PerformanceContext {
  const result:Record<string,string|number>={activityCommand:command.kind};
  if(command.kind==="read_stage"||command.kind==="read_path"||command.kind==="read_raw_result")result.readKind="content";
  if(command.kind==="observe_paths"||command.kind==="read_input_need"||command.kind==="pending")result.readKind="metadata";
  if(command.kind==="observe_state"||command.kind==="read_snapshot") {
    result.readKind=command.kind==="observe_state"?"metadata":"content";
    result.selectedStageCount=command.requestIds.length;result.selectedInputNeedCount=command.inputNeedIds.length;
    if(command.requestIds.length===1)result.stageId=command.requestIds[0]!;
  }
  if("runId" in command)result.runId=command.runId;
  if("pathId" in command&&typeof command.pathId==="string")result.pathId=command.pathId;
  if(command.kind==="observe_paths"&&command.pathIds.length===1)result.pathId=command.pathIds[0]!;
  if("requestId" in command)result.stageId=command.requestId;
  if(command.kind==="dispatch"){result.attemptId=command.attempt.id;result.stageId=command.attempt.requestId;}
  if(command.kind==="save_raw"){result.attemptId=command.result.attemptId;result.recordId=command.result.id;}
  if("receipt" in command&&"requestId" in command.receipt){result.stageId=command.receipt.requestId;result.recordId=command.receipt.id;}
  return result;
}

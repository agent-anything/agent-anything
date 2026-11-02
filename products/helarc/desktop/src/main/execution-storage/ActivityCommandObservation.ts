import type {ActivityHandoffCommand} from "@agent-anything/agent-runtime/activity";
import type {PerformanceContext} from "../diagnostics/ExecutionPerformance.js";

/** Original command identities only; this does not inspect professional input or infer progress. */
export function activityCommandObservation(command:ActivityHandoffCommand):PerformanceContext {
  const result:Record<string,string>={activityCommand:command.kind};
  if("runId" in command)result.runId=command.runId;
  if("pathId" in command&&typeof command.pathId==="string")result.pathId=command.pathId;
  if("requestId" in command)result.stageId=command.requestId;
  if(command.kind==="dispatch"){result.attemptId=command.attempt.id;result.stageId=command.attempt.requestId;}
  if(command.kind==="save_raw"){result.attemptId=command.result.attemptId;result.recordId=command.result.id;}
  if("receipt" in command&&"requestId" in command.receipt){result.stageId=command.receipt.requestId;result.recordId=command.receipt.id;}
  return result;
}

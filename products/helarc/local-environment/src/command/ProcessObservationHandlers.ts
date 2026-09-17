import type {ResolvedOperationBinding} from "@agent-anything/operation-catalog/binding";
import type {OperationResult} from "@agent-anything/operation-catalog/result";
import {createOperationResult} from "@agent-anything/operation-catalog/result";
import {RunProcessManager, ProcessManagerError} from "./RunProcessManager.js";
import {readProcessWait} from "./CommandInput.js";
import {interpretShellCommandOutcome} from "./ShellCommandOutcome.js";
import type {ProcessObservation, ProcessOutputSlice} from "./ProcessObservation.js";

export interface ProcessObservationHandler {
  readonly id:string;
  execute(context:{
    readonly runId:string;
    readonly binding:Extract<ResolvedOperationBinding,{kind:"internal"}>;
    readonly deadlineAt:string;
    readonly interruption:{readonly signal:AbortSignal};
  }):Promise<OperationResult>;
}

export function createProcessObservationHandlers(input:{
  manager:RunProcessManager;
  semantics:ReadonlyMap<string,{shell:"Bash"|"PowerShell";command:string}>;
  initialHandlerId:string;
  outputHandlerId:string;
  now:()=>string;
}):readonly ProcessObservationHandler[] {
  const handler = (initial:boolean):ProcessObservationHandler => ({
    id:initial ? input.initialHandlerId : input.outputHandlerId,
    async execute(context) {
      const startedAt = input.now();
      const request = context.binding.request;
      const base = {ref:{invocation:context.binding.invocation,id:context.binding.invocation.id+":observation-result"},
        binding:context.binding.binding,semanticOwner:"helarc",startedAt};
      let executionId:string|null = null;
      try {
        if (!record(request) || typeof request.task_id !== "string" || !request.task_id ||
            Object.keys(request).some(key=>!["task_id","cursor","wait_ms"].includes(key)) ||
            (request.cursor !== undefined && typeof request.cursor !== "string")) throw new TypeError("TaskOutput requires an exact task_id, optional cursor and wait_ms.");
        executionId=request.task_id;
        // Only the trusted composite child has the initial-observation binding.
        if (initial && context.binding.parentInvocation === null) throw new TypeError("Initial observation requires a composite invocation.");
        const remaining=Math.max(0,Date.parse(context.deadlineAt)-Date.parse(input.now()));
        const requested=readProcessWait(request.wait_ms);
        const observed=await input.manager.observe({runId:context.runId,executionId,invocationId:context.binding.invocation.id,
          cursor:request.cursor as string|undefined,waitMs:Math.min(requested,Math.floor(remaining)),requestedWaitMs:requested,signal:context.interruption.signal,initial});
        const output=projectProcessObservation(observed);
        let commandFailure:null|{code:string;message:string;retryable:false;metadata:Record<string,unknown>}=null;
        if(initial && observed.snapshot.phase === "settled") {
          const semantics=input.semantics.get(executionId);
          if(!semantics) throw new TypeError("Command interpretation is unavailable.");
          const result=interpretShellCommandOutcome({...semantics,exitCode:observed.snapshot.rootExit?.code ?? null,
            signal:observed.snapshot.rootExit?.signal ?? null,stdout:{...observed.stdout,truncated:observed.hasMore||observed.stdout.omittedBytes>0},
            stderr:{...observed.stderr,truncated:observed.hasMore||observed.stderr.omittedBytes>0}});
          if(["timed_out", "cancelled", "unknown"].includes(observed.snapshot.outcome ?? "unknown") || result.status === "failed") commandFailure={
            code:result.status === "failed" ? result.code : `shell_${observed.snapshot.outcome ?? "unknown"}`,
            message:result.status === "failed" ? result.message : "Command execution did not succeed.",retryable:false,metadata:{processObservation:output},
          };
        }
        return createOperationResult({...base,finishedAt:input.now(),status:"succeeded",failure:null,
          output:initial ? {observation:output,commandFailure} : output,
          lowerRefs:[{owner:"helarc-command",kind:"process_observation",id:observed.id,revision:"1"}],metadata:{execution:observed.execution}});
      } catch(error) {
        const snapshot=error instanceof ProcessManagerError ? error.snapshot:null;
        return createOperationResult({...base,finishedAt:input.now(),status:context.interruption.signal.aborted ? "cancelled":"failed",output:null,
          failure:{owner:"helarc-command",code:error instanceof ProcessManagerError ? error.code:"process_observation_failed",
            message:error instanceof Error ? error.message:"Process observation failed.",retryable:false,
            metadata:{executionId,process:snapshot}},lowerRefs:[],metadata:{executionId}});
      }
    },
  });
  return Object.freeze([handler(true),handler(false)]);
}

export function projectProcessObservation(value:ProcessObservation) {
  const s=value.snapshot;
  return Object.freeze({task_id:s.ref.executionId,run_id:s.ref.runId,observation_id:value.id,invocation_id:value.invocationId,
    snapshot_revision:s.revision,action_id:s.actionId,phase:s.phase,outcome:s.outcome,
    requested_wait_ms:value.requestedWaitMs,effective_wait_ms:value.effectiveWaitMs,elapsed_wait_ms:value.elapsedWaitMs,
    return_reason:value.returnReason,stdout:stream(value.stdout),stderr:stream(value.stderr),
    next_cursor:value.nextCursor,has_more:value.hasMore,process_id:s.process?.processId ?? null,helper_process_id:s.helperProcessId,
    started_at:s.startedAt,finished_at:s.finishedAt,deadline_at:s.deadlineAt,root_exit:s.rootExit,
    termination:s.termination,containment:{...s.containment,kind:s.backend.kind},output:s.output,
    initial_cwd:s.initialCwd,final_cwd:s.finalCwd,session_cwd:s.sessionCwd,cwd_disposition:s.cwdDisposition,limitations:s.limitations});
}
function stream(value:ProcessOutputSlice) {return {text:value.text,encoding:value.encoding,encoding_source:value.encodingSource,
  integrity:value.integrity,replacement_count:value.replacementCount,byte_start:value.byteStart,byte_end:value.byteEnd,
  received_bytes:value.receivedBytes,omitted_bytes:value.omittedBytes,projection_pending:value.projectionPending,segments:value.segments};}
function record(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==="object"&&!Array.isArray(value);}

import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import type {ProtocolRevisionRef} from "@agent-anything/model-interaction/protocol";
import type {AgentStopEvent} from "@agent-anything/agent-hooks/events";
import type {InvocationInterruptionContext} from "@agent-anything/agent-core/control";
import {HelarcNativeStructuredExecution,validateHelarcNativeStructuredRequest,prepareHelarcResponsesStructured,prepareHelarcDeepSeekStructured,prepareHelarcOllamaStructured,type HelarcNativeStructuredRequest} from "../controller/native/HelarcNativeStructuredExecution.js";
import {readHelarcNativeTaskEvidence,type HelarcNativeTaskInputPorts} from "../controller/native/HelarcNativeTaskInput.js";
import type {ProtocolModelActivity} from "@agent-anything/agent-runtime/model-access";
import {ActivityCheckpointError} from "@agent-anything/agent-runtime/activity";
import {HELARC_TASK_FULFILLMENT_SCHEMA,readHelarcTaskObjective,interpretHelarcFulfillmentValue,type HelarcStopEvaluation} from "./HelarcTaskFulfillmentHook.js";

export interface HelarcNativeStopSource {
  readonly source:ProtocolRevisionRef;
  readonly activityId:string;
  readonly event:AgentStopEvent;
  readonly instructions:string;
  readonly schema:typeof HELARC_TASK_FULFILLMENT_SCHEMA;
}
export function createHelarcNativeStopSource(event:AgentStopEvent,instructions:string):HelarcNativeStopSource {
  if(!instructions.trim())throw new TypeError("stop_source_requires_enabled_instructions");
  readHelarcTaskObjective(event);
  const basis={event,instructions,schema:HELARC_TASK_FULFILLMENT_SCHEMA};
  return {...basis,activityId:`${event.ref.id}:task-fulfillment`,source:{id:`${event.ref.id}:native-stop-source`,revision:digest(basis)}};
}

type StopEvidencePorts=Pick<HelarcNativeTaskInputPorts,"journal"|"contextSelections">;
async function stopEvidence(source:HelarcNativeStopSource,activity:ProtocolModelActivity,ports:StopEvidencePorts){
  const event=source.event;
  if(digest(source)!==digest(createHelarcNativeStopSource(event,source.instructions))||event.interaction.kind!=="native_evidence"||
    event.run.id!==activity.scope.runId||activity.scope.activityId!==source.activityId||activity.scope.purpose.id!=="helarc.task-fulfillment")
    throw new TypeError("native_stop_evidence_binding_changed");
  const settledInteraction=await readHelarcNativeTaskEvidence(event.interaction,{...ports,composition:activity.composition});
  return {role:"user" as const,content:JSON.stringify({kind:"host_task_fulfillment_evidence",originalTask:readHelarcTaskObjective(event),
    completionProposal:event.candidate.kind==="complete"?event.candidate.output:null,
    completionBasis:{candidate:event.candidate.ref,plan:event.plan,pending:event.pending},
    unsettledCallCount:event.interaction.unsettledCalls.length,settledCallCount:event.interaction.settledCallCount,settledInteraction})};
}
export async function prepareHelarcResponsesStop(source:HelarcNativeStopSource,activity:ProtocolModelActivity,ports:StopEvidencePorts,
  options:Pick<Parameters<typeof prepareHelarcResponsesStructured>[1],"stream"|"store"|"reasoning">){
  return prepareHelarcResponsesStructured({source:source.source,activity},{...options,instructions:source.instructions,
    input:[await stopEvidence(source,activity,ports)],textSchema:source.schema});
}
export async function prepareHelarcDeepSeekStop(source:HelarcNativeStopSource,activity:ProtocolModelActivity,ports:StopEvidencePorts,
  options:Pick<Parameters<typeof prepareHelarcDeepSeekStructured>[1],"stream"|"thinking">){
  return prepareHelarcDeepSeekStructured({source:source.source,activity},{...options,
    messages:[{role:"system",content:`${source.instructions}\nReturn JSON matching the supplied output contract.`},await stopEvidence(source,activity,ports)],jsonSchema:source.schema});
}
export async function prepareHelarcOllamaStop(source:HelarcNativeStopSource,activity:ProtocolModelActivity,ports:StopEvidencePorts,
  options:Pick<Parameters<typeof prepareHelarcOllamaStructured>[1],"stream"|"think"|"options">){
  return prepareHelarcOllamaStructured({source:source.source,activity},{...options,
    messages:[{role:"system",content:source.instructions},await stopEvidence(source,activity,ports)],format:source.schema});
}
/** Stop owns the business judgment. The selected native purpose owns input, transport and source retention. */
export function createHelarcNativeStopEvaluation(ports:{
  readonly execution:HelarcNativeStructuredExecution;
  readonly prepare:(source:HelarcNativeStopSource,context:InvocationInterruptionContext)=>Promise<HelarcNativeStructuredRequest>;
  readonly interruptInput?:(source:HelarcNativeStopSource,context:InvocationInterruptionContext)=>Promise<void>;
}):HelarcStopEvaluation {
  return {kind:"purpose",id:"helarc.native-stop",async evaluate(event,instructions,context,_mode){
    const source=createHelarcNativeStopSource(event,instructions);
    try{
    let result=await ports.execution.recover(source.activityId,context);
    if(!result){
      const request=await ports.prepare(source,context);
      validateHelarcNativeStructuredRequest(request);
      if(request.activity.scope.activityId!==source.activityId||request.activity.scope.runId!==event.run.id||
        request.activity.scope.purpose.id!=="helarc.task-fulfillment"||digest(request.source)!==digest(source.source)||
        digest(request.schema.canonical)!==digest(source.schema))throw new TypeError("native_stop_source_binding_changed");
      result=await ports.execution.execute(request,context);
    }
    if(digest(result.source)!==digest(source.source)||result.evidence.scope.runId!==event.run.id||
      result.evidence.scope.activityId!==source.activityId||result.evidence.scope.purpose.id!=="helarc.task-fulfillment")
      throw new TypeError("native_stop_result_binding_changed");
    if(result.assessment.outcome!=="valid")throw new Error(`native_stop_assessment_unavailable:${result.assessment.failure?.code??result.assessment.outcome}`);
    return interpretHelarcFulfillmentValue(event,result.assessment.value,result.interpretedAt);
    }catch(error){
      if(context.signal.aborted&&context.interruption!==null){
        const settling={...context,signal:new AbortController().signal};
        try{
          await ports.interruptInput?.(source,settling);
          await ports.execution.interrupt(source.activityId,source.source,settling);
        }catch(cause){throw new ActivityCheckpointError(`${source.activityId}:stop-input-interruption`,{cause});}
      }
      throw error;
    }
  }};
}

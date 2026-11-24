import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {OPENAI_RESPONSES,DEEPSEEK_CHAT_COMPLETIONS,OLLAMA_CHAT,requireModelPurpose,
  type ModelAgentCompositionBinding,type ModelInteractionProtocolRef,type ModelPurposeParticipants,type ProtocolRevisionRef} from "@agent-anything/model-interaction/protocol";
import {bindProtocolModelActivity,type ProtocolModelActivity} from "@agent-anything/agent-runtime/model-access";
import type {InvocationInterruptionContext} from "@agent-anything/agent-core/control";
import type {ContextSelectionPort} from "@agent-anything/context/selection";
import type {RepresentationMethodModelParticipant} from "@agent-anything/agent-runtime/context-representation";
import {HelarcNativeStructuredExecution,HELARC_NATIVE_STRUCTURED_INTERPRETER,type HelarcNativeStructuredRequest} from "../controller/native/HelarcNativeStructuredExecution.js";
import {HelarcNativeRepresentationEvaluation,prepareHelarcResponsesRepresentation,prepareHelarcDeepSeekRepresentation,prepareHelarcOllamaRepresentation,
  type HelarcNativeRepresentationSource} from "../controller/native/HelarcNativeRepresentationEvaluation.js";
import {HelarcNativeRepresentationMethodParticipant} from "../controller/native/HelarcNativeRepresentationMethodParticipant.js";
import {assertHelarcNativeStructuredInput} from "../controller/native/HelarcNativeStructuredInput.js";
import {createHelarcNativeStopEvaluation,prepareHelarcResponsesStop,prepareHelarcDeepSeekStop,prepareHelarcOllamaStop,
  type HelarcNativeStopSource} from "../task-fulfillment/HelarcNativeStopEvaluation.js";

type Source=HelarcNativeRepresentationSource|HelarcNativeStopSource;
type ExecutionPorts=ConstructorParameters<typeof HelarcNativeStructuredExecution>[0];
export interface HelarcNativeStructuredPurposePorts {
  readonly execution:ExecutionPorts;
  readonly selections:ContextSelectionPort;
  readonly methodPurpose:ProtocolRevisionRef;
  /** Original accepted Run composition; this resolver is not model selection. */
  readonly composition:(runId:string)=>Promise<ModelAgentCompositionBinding>;
  readonly conditions:(source:Source,context:InvocationInterruptionContext)=>Promise<ProtocolModelActivity["conditions"]>;
  readonly retainTransport:(request:HelarcNativeStructuredRequest,context:InvocationInterruptionContext)=>Promise<HelarcNativeStructuredRequest>;
  readonly prepareInput?:(request:HelarcNativeStructuredRequest,source:Source,context:InvocationInterruptionContext)=>Promise<HelarcNativeStructuredRequest>;
  readonly inputRevision?:"2"|"3";
  readonly restoreInput?:(source:Source,context:InvocationInterruptionContext)=>Promise<HelarcNativeStructuredRequest|null>;
  readonly interruptInput?:(source:Source,context:InvocationInterruptionContext)=>Promise<void>;
}
export function createHelarcResponsesStructuredPurposes(ports:HelarcNativeStructuredPurposePorts,
  options:Parameters<typeof prepareHelarcResponsesRepresentation>[2]){
  return compose(ports,OPENAI_RESPONSES,(s,a)=>prepareHelarcResponsesRepresentation(s,a,options),
    (s,a)=>prepareHelarcResponsesStop(s,a,{journal:ports.execution.journal,contextSelections:ports.selections},options));
}
export function createHelarcDeepSeekStructuredPurposes(ports:HelarcNativeStructuredPurposePorts,
  options:Parameters<typeof prepareHelarcDeepSeekRepresentation>[2]){
  return compose(ports,DEEPSEEK_CHAT_COMPLETIONS,(s,a)=>prepareHelarcDeepSeekRepresentation(s,a,options),
    (s,a)=>prepareHelarcDeepSeekStop(s,a,{journal:ports.execution.journal,contextSelections:ports.selections},options));
}
export function createHelarcOllamaStructuredPurposes(ports:HelarcNativeStructuredPurposePorts,
  options:Parameters<typeof prepareHelarcOllamaRepresentation>[2]){
  return compose(ports,OLLAMA_CHAT,(s,a)=>prepareHelarcOllamaRepresentation(s,a,options),
    (s,a)=>prepareHelarcOllamaStop(s,a,{journal:ports.execution.journal,contextSelections:ports.selections},options));
}
function compose(ports:HelarcNativeStructuredPurposePorts,protocol:ModelInteractionProtocolRef,
  method:(source:HelarcNativeRepresentationSource,activity:ProtocolModelActivity)=>HelarcNativeStructuredRequest,
  stop:(source:HelarcNativeStopSource,activity:ProtocolModelActivity)=>Promise<HelarcNativeStructuredRequest>){
  const participants:readonly ModelPurposeParticipants[]=[ports.methodPurpose,{id:"helarc.task-fulfillment",revision:"1"}].map(purpose=>({purpose,
    input:{implementation:{id:`helarc.${protocol.id}.${purpose.id}-input`,revision:ports.prepareInput?ports.inputRevision??"2":"1"},protocol},
    interpreter:{implementation:HELARC_NATIVE_STRUCTURED_INTERPRETER,protocol}}));
  if(!ports.methodPurpose.id||ports.methodPurpose.id==="helarc.task-fulfillment")throw new TypeError("native_structured_purpose_collision");
  async function original(runId:string,purpose:ProtocolRevisionRef){
    const binding=await ports.composition(runId),participant=requireModelPurpose(binding,purpose);
    const expected=participants.find(p=>digest(p.purpose)===digest(purpose));
    if(digest(binding.composition.protocol)!==digest(protocol)||!expected||!supports(participant))
      throw new TypeError("native_structured_composition_changed");
    return binding;
  }
  const execution=new HelarcNativeStructuredExecution({...ports.execution,authorize:async(request,context)=>{
    const binding=await original(request.activity.scope.runId,request.activity.scope.purpose);
    if(binding.digest!==request.activity.composition.digest)throw new TypeError("native_structured_original_composition_changed");
    await ports.execution.authorize(request,context);
  }});
  async function prepare(source:Source,context:InvocationInterruptionContext){
    context.signal.throwIfAborted();
    const isStop="event" in source,runId=isStop?source.event.run.id:source.runId;
    const purpose=isStop?participants[1]!.purpose:ports.methodPurpose,composition=await original(runId,purpose);
    if(isStop&&(composition.composition.agent.id!==source.event.agent.id||composition.composition.agent.revision!==source.event.agent.revision))
      throw new TypeError("native_stop_original_agent_changed");
    const activity=bindProtocolModelActivity({composition,scope:{runId,activityId:source.activityId,
      recipientId:isStop?source.event.agent.id:source.recipientId,purpose,compositionDigest:composition.digest},conditions:await ports.conditions(source,context)});
    const participant=requireModelPurpose(composition,purpose);
    const restored=participant.input.implementation.revision==="3"?await ports.restoreInput?.(source,context):null;
    const request=restored??(isStop?await stop(source,activity):method(source,activity));
    if(digest(request.activity)!==digest(activity)||digest(request.source)!==digest(source.source))
      throw new TypeError("native_structured_original_preparation_changed");
    let prepared=request;
    if(!restored&&["2","3"].includes(participant.input.implementation.revision)){
      if(!ports.prepareInput)throw new TypeError("native_structured_original_input_participant_unavailable");
      prepared=await ports.prepareInput(request,source,context);
      const {inputPreparation:_preparation,...unmodified}=prepared;
      if(digest(unmodified)!==digest(request))
        throw new TypeError("native_structured_preparation_changed_request");
      assertHelarcNativeStructuredInput(prepared);
    }
    const retained=await ports.retainTransport(prepared,context);
    if(digest(retained.activity)!==digest(activity)||retained.wire.digest!==request.wire.digest||digest(retained.source)!==digest(request.source))
      throw new TypeError("native_structured_transport_changed_input");
    if(digest(retained.inputPreparation??null)!==digest(prepared.inputPreparation??null))throw new TypeError("native_structured_transport_changed_preparation");
    return retained;
  }
  const evaluation=new HelarcNativeRepresentationEvaluation({execution,prepare,...(ports.interruptInput?{interruptInput:ports.interruptInput}:{})});
  const run:RepresentationMethodModelParticipant["execute"]=async(input,path,stage,signal)=>{
    const binding=await original(path.intent.runId,ports.methodPurpose);
    return new HelarcNativeRepresentationMethodParticipant(binding,evaluation).execute(input,path,stage,signal);
  };
  const methodParticipant:RepresentationMethodModelParticipant={execute:run,reconcile:async(input,path,stage,signal)=>{
    const binding=await original(path.intent.runId,ports.methodPurpose);
    return new HelarcNativeRepresentationMethodParticipant(binding,evaluation).reconcile(input,path,stage,signal);
  },interrupt:async(input,path,stage,signal)=>{
    const binding=await original(path.intent.runId,ports.methodPurpose);
    return new HelarcNativeRepresentationMethodParticipant(binding,evaluation).interrupt(input,path,stage,signal);
  }};
  function supports(candidate:ModelPurposeParticipants):boolean{
    const current=participants.find(p=>digest(p.purpose)===digest(candidate.purpose));
    if(!current)return false;
    const revisions=current.input.implementation.revision==="3"?["1","2","3"]:current.input.implementation.revision==="2"?["1","2"]:["1"];
    return revisions.some(revision=>digest(candidate)===digest({...current,input:{...current.input,implementation:{...current.input.implementation,revision}}}));
  }
  return {participants,supports,methodParticipant,stopEvaluation:createHelarcNativeStopEvaluation({execution,prepare,
    ...(ports.interruptInput?{interruptInput:ports.interruptInput}:{})})};
}

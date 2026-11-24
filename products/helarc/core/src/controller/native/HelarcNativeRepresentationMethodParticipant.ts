import type {RepresentationMethodModelParticipant,RepresentationMethodModelInput,RepresentationMethodModelResult} from "@agent-anything/agent-runtime/context-representation";
import type {ActivityPathState,ActivityStageState} from "@agent-anything/agent-runtime/activity";
import type {ModelAgentCompositionBinding} from "@agent-anything/model-interaction/protocol";
import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {createHelarcNativeRepresentationSource,HelarcNativeRepresentationEvaluation} from "./HelarcNativeRepresentationEvaluation.js";

/** Binds the professional path to its original native participant; it does not own method policy. */
export class HelarcNativeRepresentationMethodParticipant implements RepresentationMethodModelParticipant {
  constructor(private readonly composition:ModelAgentCompositionBinding,private readonly evaluation:HelarcNativeRepresentationEvaluation){}
  async execute(input:RepresentationMethodModelInput,path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal):Promise<RepresentationMethodModelResult>{
    return (await this.run(input,path,stage,signal,false))!;
  }
  reconcile(input:RepresentationMethodModelInput,path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal):Promise<RepresentationMethodModelResult|null>{
    return this.run(input,path,stage,signal,true);
  }
  interrupt(input:RepresentationMethodModelInput,path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal){
    if(!path.cancelled)throw new TypeError("native_method_interruption_not_accepted");
    return this.evaluation.interrupt(this.source(input,path,stage),{signal,interruption:null});
  }
  private source(input:RepresentationMethodModelInput,path:ActivityPathState,stage:ActivityStageState){
    const r=input.request;
    if(!r.nativeComposition||digest(r.nativeComposition)!==digest(this.composition)||r.template||r.recipient.runId!==path.intent.runId||
      stage.request.pathId!==path.intent.id||stage.request.stageKind!=="model")throw new TypeError("native_method_participant_binding_changed");
    return createHelarcNativeRepresentationSource({runId:r.recipient.runId,recipientId:r.recipient.recipient,job:input.job,evidence:input.evidence,
      inputCapacity:{targetRevision:r.targetRevision,capacity:r.capacity},
      ...(this.composition.composition.auxiliary.some(p=>p.purpose.id===r.recipient.purpose&&p.input.implementation.revision==="3")&&
        this.composition.composition.auxiliary.some(p=>p.purpose.id==="context_input_measurement")&&r.capacity.maximumMeasurements>0?
        {measurement:{pathId:path.intent.id,stageId:stage.request.id,maximumCalls:r.capacity.maximumMeasurements}}:{}),
      scope:{methodRevision:r.methodRevision,objective:r.objective,sources:r.sources,requirements:r.requirements,relationships:r.relationships,
        sourceBoundary:r.sourceBoundary,combinationDigest:r.combinationDigest,...(r.combination?{combination:r.combination}:{}),...(r.restorations?{restorations:r.restorations}:{})}});
  }
  private async run(input:RepresentationMethodModelInput,path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal,recover:boolean):Promise<RepresentationMethodModelResult|null>{
    if(path.cancelled)throw new TypeError("native_method_cancelled_execution_forbidden");
    const source=this.source(input,path,stage),r=input.request;
    const result=await this.evaluation[recover?"recover":"evaluate"](source,{signal,interruption:null});
    if(!result)return null;
    if(result.kind==="input_unavailable")return {kind:result.kind,inputDigest:digest(input),code:result.code,details:result.details};
    if(result.evidence.scope.compositionDigest!==this.composition.digest||result.evidence.scope.purpose.id!==r.recipient.purpose)
      throw new TypeError("native_method_participant_result_changed");
    return result.kind==="contract_result"?{kind:result.kind,value:result.contractValue,evidence:result.evidence}:result;
  }
}

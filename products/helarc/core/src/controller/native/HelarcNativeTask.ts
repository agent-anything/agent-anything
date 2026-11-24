import { createNativeModelCallRef, snapshotModelCallableRequest, snapshotModelJsonValue, type ModelCallableRequest, type ModelCallRef, type ModelJsonValue } from "@agent-anything/model-interaction";
import { modelInputValueDigest } from "@agent-anything/model-interaction/input";
import { snapshotNativeModelSource, snapshotModelPurposeEvidence, type ModelPurposeEvidence, type NativeModelSourceRef,
  type ModelInteractionScope, type ProtocolRevisionRef, type ModelInteractionProtocolRef } from "@agent-anything/model-interaction/protocol";
import { compileNativeCatalog, NativeProtocolError, type NativeCallableCatalog, type NativeSchemaSpec, type NativeSchemaWork } from "@agent-anything/provider-integrations/native";
import { validatePlanUpdate, type PlanLimits } from "@agent-anything/agent-runtime/plan";
import { finalResultInputError } from "../HelarcFinalResultInput.js";
import { selectHelarcFinalReplyText, createHelarcEndingSignalFeedback } from "../HelarcFinalReply.js";
import { type HelarcModelCallableBinding } from "../HelarcModelCallableCatalog.js";

export const HELARC_NATIVE_TASK_INTERPRETER={id:"helarc.native-task",revision:"1"} as const;
import type {HelarcNativeTaskBinding,HelarcNativeTaskText,HelarcCommittedTaskReply,HelarcNativeTaskProposal} from "./HelarcNativeTaskContracts.js";
export type {HelarcNativeTaskBinding,HelarcNativeTaskText,HelarcCommittedTaskReply,HelarcNativeTaskProposal} from "./HelarcNativeTaskContracts.js";
export function nativeTaskCatalog(binding:Omit<HelarcNativeTaskBinding,"catalogRevision">,observe?:(work:NativeSchemaWork)=>void):NativeCallableCatalog {
  const catalog=compileNativeCatalog({protocol:binding.protocol,purpose:binding.scope.purpose,definitions:binding.catalog.map(c=>c.definition),mode:binding.schemaMode},observe);
  if(binding.catalog.some(c=>c.definition.name!==c.binding.callableName)||
    binding.catalog.some(c=>c.binding.kind!=="tool"&&(c.binding.kind!=="control"||
      c.binding.control!==c.binding.callableName||!["update_plan","final_result"].includes(c.binding.control)))||
    new Set(binding.catalog.map(c=>c.binding.callableName)).size!==binding.catalog.length)throw new NativeProtocolError("helarc_native_catalog_invalid");
  return catalog;
}

/** Product meaning accumulated by a Protocol-specific reader, not a normalized Provider response. */
export class HelarcNativeTaskInterpretation {
  private readonly catalog:NativeCallableCatalog;
  private readonly text:HelarcNativeTaskText[]=[];
  private readonly refusals:HelarcNativeTaskText[]=[];
  private readonly sources:NativeModelSourceRef[]=[];
  private readonly calls:{call:ModelCallableRequest;binding:HelarcModelCallableBinding}[]=[];
  private readonly rejections:HelarcNativeTaskProposal["rejections"][number][]=[];
  private ordinal=0;
  private readonly binding:HelarcNativeTaskBinding;
  constructor(binding:HelarcNativeTaskBinding,protocol:ModelInteractionProtocolRef,adapter:ProtocolRevisionRef){
    this.binding=snapshotModelJsonValue(binding,"native task binding") as unknown as HelarcNativeTaskBinding;
    if(modelInputValueDigest(binding.protocol)!==modelInputValueDigest(protocol)||modelInputValueDigest(binding.adapter)!==modelInputValueDigest(adapter)||
      modelInputValueDigest(binding.interpreter)!==modelInputValueDigest(HELARC_NATIVE_TASK_INTERPRETER))throw new NativeProtocolError("helarc_native_original_interpreter_unavailable");
    this.catalog=nativeTaskCatalog(this.binding);
    if(this.catalog.revision!==binding.catalogRevision)throw new NativeProtocolError("helarc_native_original_mapping_mismatch");
  }
  source(pointer:string,nativeIdentity:NativeModelSourceRef["nativeIdentity"]):NativeModelSourceRef{
    const source=snapshotNativeModelSource({scope:this.binding.scope,protocol:this.binding.protocol,interpretation:this.binding.adapter,
      operationId:this.binding.operationId,record:this.binding.record,position:{format:"json-pointer",value:pointer},nativeIdentity});
    this.sources.push(source);return source;
  }
  addText(source:NativeModelSourceRef,text:string):void{this.text.push({source,text});}
  addRefusal(source:NativeModelSourceRef,text:string):void{this.refusals.push({source,text});}
  addCall(source:NativeModelSourceRef,nativeCallId:string|null,name:string,wire:unknown):void{
    const ordinal=this.ordinal++,ref=createNativeModelCallRef({providerRequestId:this.binding.requestId,controllerRequestId:this.binding.controllerRequestId,
      branchId:this.binding.scope.runId,contentBlockOrdinal:ordinal,nativeSource:source,purposeAcceptance:this.binding.acceptance});
    const reject=(code:string,message:string)=>this.rejections.push({call:ref,nativeCallId,name,code,message});
    const entry=this.catalog.entries.find(e=>e.definition.name===name),owned=this.binding.catalog.find(c=>c.binding.callableName===name);
    if(!entry||!owned){reject("helarc_unknown_callable",`No operation was executed for this call. Use an exact function name from this request's tools: ${this.catalog.entries.map(e=>e.definition.name).join(", ")}. Do not repeat calls that already succeeded.`);return;}
    let input:unknown;
    try{input=typeof wire==="string"?entry.codec.parse(wire):entry.codec.decode(wire);}
    catch(error){
      if(!(error instanceof NativeProtocolError))throw error;
      reject(error.code,`No operation was executed for this call. Correct the arguments against this function's supplied wire schema. ${JSON.stringify(error.details)} Other calls retain their own results.`);return;
    }
    if(!input||typeof input!=="object"||Array.isArray(input))throw new NativeProtocolError("helarc_native_function_object_required");
    if(Buffer.byteLength(JSON.stringify(input))>131072){reject("helarc_native_call_input_too_large","No operation was executed for this call. Decoded arguments exceed the local 131072-byte invocation limit. Reduce this call's arguments; other calls retain their own results.");return;}
    const call=snapshotModelCallableRequest({modelCallRef:ref,providerCallRef:nativeCallId===null?null:{providerId:this.binding.protocol.id,id:nativeCallId},
      name,input:input as Record<string,ModelJsonValue>,ordinal});
    if(owned.binding.kind==="control"&&owned.binding.control==="update_plan"){
      const failure=validatePlanUpdate(input,this.binding.planLimits);if(failure){reject("helarc_plan_invalid",failure.message);return;}
    }
    this.calls.push({call,binding:owned.binding});
  }
  finish(previous:HelarcCommittedTaskReply|null):HelarcNativeTaskProposal{
    if(previous){
      if(previous.scope.runId!==this.binding.scope.runId||previous.scope.recipientId!==this.binding.scope.recipientId||
        modelInputValueDigest(previous.scope.purpose)!==modelInputValueDigest(this.binding.scope.purpose)||
        previous.acceptance.id===this.binding.acceptance.id||previous.text.some(t=>modelInputValueDigest(t.source.scope)!==modelInputValueDigest(previous.scope)||
          modelInputValueDigest(t.source.protocol)!==modelInputValueDigest(this.binding.protocol)||
          modelInputValueDigest(t.source.record)!==modelInputValueDigest(previous.responseRecord)))throw new NativeProtocolError("helarc_previous_task_source_invalid");
    }
    const finals=this.calls.filter(c=>c.binding.kind==="control"&&c.binding.control==="final_result");
    const separatePlan=this.calls.some(c=>c.binding.kind==="control"&&c.binding.control==="update_plan");
    let ending:HelarcNativeTaskProposal["ending"]=null;
    for(const f of finals){
      const failure=finals.length>1?"Exactly one final_result is allowed.":separatePlan?"Use final_result.plan instead of submitting update_plan alongside final_result.":
        finalResultInputError(f.call.input,this.binding.hasPlan,this.binding.planLimits);
      if(failure){
        this.rejections.push({call:f.call.modelCallRef,nativeCallId:f.call.providerCallRef?.id??null,name:f.call.name,code:"helarc_final_result_invalid",message:failure});
        this.calls.splice(this.calls.indexOf(f),1);continue;
      }
      const current=this.text.map((t,i)=>({modelItemId:String(i),ordinal:i,text:t.text}));
      const prior=previous?.text.map((t,i)=>({modelItemId:String(i),ordinal:i,text:t.text}))??[];
      const reply=selectHelarcFinalReplyText({input:f.call.input,current,previous:prior});
      const texts=reply.disposition==="adopted_current"?this.text:reply.disposition==="adopted_previous"?previous!.text:[];
      ending={call:f.call.modelCallRef,disposition:reply.disposition,response:reply.summary,
        text:reply.disposition==="supplied"?[{source:f.call.modelCallRef.nativeSource!,text:reply.summary}]:texts.filter(t=>t.text.trim()),
        sources:reply.disposition==="supplied"||reply.disposition==="explicit_empty"?[f.call.modelCallRef.nativeSource!]:texts.filter(t=>t.text.trim()).map(t=>t.source),
        plan:f.call.input.plan??null,materialRefs:f.call.input.material_refs??null};
    }
    if(!ending&&!this.calls.length&&!this.rejections.length&&this.refusals.length)ending={call:null,disposition:"refusal",response:this.refusals.map(r=>r.text).join("\n\n"),
      text:this.refusals,
      sources:this.refusals.map(r=>r.source),plan:null,materialRefs:null};
    const kind=ending?"propose_completion":this.calls.length||this.rejections.length?"advance":"continue_with_feedback";
    const evidence=snapshotModelPurposeEvidence({scope:this.binding.scope,interpreter:this.binding.interpreter,acceptance:this.binding.acceptance,sources:this.sources});
    let wireEndingExample:string|null=null;
    const finalCodec=this.catalog.entries.find(e=>e.definition.name==="final_result")?.codec;
    if(finalCodec&&!this.binding.hasPlan){try{wireEndingExample=JSON.stringify(finalCodec.encode({}));}catch{/* The bound catalog remains authoritative. */}}
    return Object.freeze({evidence,kind,text:Object.freeze(this.text),refusals:Object.freeze(this.refusals),calls:Object.freeze(this.calls),rejections:Object.freeze(this.rejections),ending,
      feedback:kind==="continue_with_feedback"?{code:"helarc_ending_signal_missing",message:createHelarcEndingSignalFeedback({hasText:this.text.some(t=>!!t.text.trim()),hasPlan:this.binding.hasPlan,wireEndingExample})}:null});
  }
}

import {Buffer} from "node:buffer";
import {TextDecoder} from "node:util";
import {containsMaterialRange,MaterialCustodyError,type MaterialAccess,type MaterialAccessDescription,type MaterialCustodyPort,type MaterialReadPage} from "@agent-anything/context/custody";
import {fillModelResultTextSlots,modelInputValueDigest,validateInputDemand,type ModelResultTextSlot,type ModelToolMessage,type InputOrganizationDemand,type InputContribution,type InputOption,type ModelInputSectionCandidate} from "@agent-anything/model-interaction/input";
import {ActivityPurposeRegistry,type ActivityPurposeBinding,type ActivityPurposeContract} from "../activity/ActivityPurpose.js";
import type {ActivityPurposeHandler} from "../activity/ActivityHandoffProcessor.js";
import type {ActivityHandoffPort,ActivityPathIntent,ActivityPathState,ActivityStageState,ActivityStageRequest,ActivityRawResult,ActivityAttempt} from "../activity/ActivityHandoff.js";
import type {SharedAcceptancePart} from "../activity/SharedAcceptance.js";
import type {ContextInputPreparationRequest} from "./ContextInputPreparation.js";
import type {ContextInputPreparationWork} from "./ContextInputPreparationWork.js";

export const CONTEXT_INPUT_MATERIALIZATION_PURPOSE:ActivityPurposeContract={
  ref:{id:"context.input-materialization",revision:"3"},inputOwner:"context-representation",executionOwner:"model-input",
  interpretationOwner:"context-representation",acceptanceOwner:"context-representation",recoveryOwner:"context-representation",
  stageKinds:["read","assemble"],capabilities:["material-read"],continuationKinds:["stage_request"],
};
export interface RetainedInputText {
  readonly kind:"retained_text";
  readonly access:MaterialAccess;
  readonly prefix:string;
  readonly suffix:string;
}
export interface RetainedResultText {
  readonly kind:"retained_result_text";
  readonly message:ModelToolMessage;
  readonly replacements:readonly (Omit<RetainedInputText,"kind"> & {readonly slot:ModelResultTextSlot})[];
}
export type MaterialInputSection=Omit<ModelInputSectionCandidate,"content"> & {readonly content:ModelInputSectionCandidate["content"]|RetainedInputText|RetainedResultText};
export type MaterialInputDemand=Omit<InputOrganizationDemand,"contributions"> & {readonly contributions:readonly (Omit<InputContribution,"options"> & {
  readonly options:readonly (Omit<InputOption,"sections"> & {readonly sections:readonly {readonly position:number;readonly section:MaterialInputSection}[]})[];
})[]};
type WorkIntent=Omit<ActivityPathIntent,"purpose"|"owner">;
export interface ContextInputMaterializationRequest {
  readonly kind:"context_input_materialization";
  readonly demand:MaterialInputDemand;
  readonly preparation:Omit<ContextInputPreparationRequest,"demand">;
  readonly preparationIntent:WorkIntent;
  readonly pageBytes:number;
}
interface ReadReceipt {readonly accessId:string;readonly start:number;readonly end:number;readonly stageId:string;readonly rawResultId:string;}
interface MaterializationStageInput {readonly request:ContextInputMaterializationRequest;readonly pages:readonly ReadReceipt[];}
type MaterializationValue=
  | {readonly kind:"page";readonly accessId:string;readonly page:MaterialReadPage}
  | {readonly kind:"assembled";readonly request:ContextInputPreparationRequest}
  | {readonly kind:"gap";readonly reason:string};
interface MaterializationProgress {readonly kind:"input_materialization";readonly state:"reading"|"organized"|"gap";readonly stageId:string;readonly rawResultId:string;
  readonly pages:readonly ReadReceipt[];readonly preparationPathId?:string;readonly reason?:string;}
interface Dependencies {readonly materials:MaterialCustodyPort;readonly preparation:Pick<ContextInputPreparationWork,"prepareSubmission">;
  readonly authorize:ActivityPurposeHandler["authorize"];readonly now:()=>string;}

/** Resolves explicitly declared material text. It makes no representation or quality decision. */
export class ContextInputMaterializationWork implements ActivityPurposeHandler {
  static initialStage(pathId:string,request:ContextInputMaterializationRequest):ActivityStageRequest {
    return materializationStage(pathId,1,{request,pages:[]},[]);
  }
  readonly purpose:ActivityPurposeBinding;
  constructor(private readonly port:ActivityHandoffPort,registry:ActivityPurposeRegistry<ActivityPurposeHandler>,private readonly dependencies:Dependencies) {
    this.purpose=registry.register(CONTEXT_INPUT_MATERIALIZATION_PURPOSE,this);
  }
  prepareSubmission(intent:WorkIntent,request:ContextInputMaterializationRequest):readonly [SharedAcceptancePart,SharedAcceptancePart] {
    validateRequest(request);
    if(intent.runId!==request.demand.runId||intent.id===request.preparationIntent.id||intent.permissionBasis!==request.preparationIntent.permissionBasis)
      throw new TypeError("input_materialization_scope_invalid");
    const requiredStages=1+accesses(request).reduce((total,access)=>total+Math.ceil((access.range.end-access.range.start)/request.pageBytes),0);
    if(requiredStages>intent.maximumStages||requiredStages>intent.maximumAttempts)throw new TypeError("input_materialization_known_work_exceeds_delegation");
    return [{owner:"activity",kind:"path_opening",proposal:{...intent,owner:this.purpose.contract.acceptanceOwner,purpose:this.purpose}},
      {owner:"activity",kind:"stage_submission",proposal:ContextInputMaterializationWork.initialStage(intent.id,request)}];
  }
  async authorize(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal,action:Parameters<ActivityPurposeHandler["authorize"]>[3]):ReturnType<ActivityPurposeHandler["authorize"]> {
    const {request}=stageInput(stage);validateRequest(request);
    if(path.intent.purpose.digest!==this.purpose.digest||path.intent.runId!==request.demand.runId||path.intent.permissionBasis!==request.preparationIntent.permissionBasis)
      throw new TypeError("input_materialization_binding_invalid");
    const authorization=await this.dependencies.authorize(path,stage,signal,action);
    if(authorization.kind!=="allowed"||action==="settlement")return authorization;
    const pending=stage.request.stageKind==="read"?nextRead(stageInput(stage)):null;
    for(const access of pending?[pending.access]:accesses(request)) {
      signal.throwIfAborted();
      const value=await this.dependencies.materials.command({kind:"describe",holdId:access.holdId,recipient:access.recipient}) as MaterialAccessDescription|null;
      if(!value||!containsMaterialRange(value.hold.range,access.range)||!containsMaterialRange({...value.version.ref,start:0,end:value.version.bytes,coordinate:"bytes"},access.range))
        throw new TypeError("input_materialization_access_unavailable");
      if(value.version.format!=="utf8"&&value.version.format!=="json")throw new TypeError("input_materialization_text_format_required");
    }
    return authorization;
  }
  async execute(path:ActivityPathState,stage:ActivityStageState,attempt:ActivityAttempt,signal:AbortSignal):Promise<ActivityRawResult> {
    const start=performance.now(),input=stageInput(stage);signal.throwIfAborted();
    let value:MaterializationValue;
    try {
      const pending=nextRead(input);
      if(stage.request.stageKind==="read"&&pending) {
        const page=await this.dependencies.materials.command({kind:"read",access:pending.access,offset:pending.start,length:pending.end-pending.start}) as MaterialReadPage;
        validatePage(pending,page);value={kind:"page",accessId:accessKey(pending.access),page};
      }else if(stage.request.stageKind==="assemble"&&!pending)value={kind:"assembled",request:await this.assemble(path,input,signal)};
      else throw new TypeError("input_materialization_stage_invalid");
    }catch(error) {
      if(error instanceof MaterialCustodyError)value={kind:"gap",reason:error.code};
      else if(error instanceof TypeError&&error.message==="input_materialization_encoding_invalid")value={kind:"gap",reason:error.message};
      else throw error;
    }
    const elapsedMs=performance.now()-start;
    return {id:`${attempt.id}:raw`,attemptId:attempt.id,completeness:"complete",outcome:"returned",value:{...value,elapsedMs},
      usage:{localMs:elapsedMs,materialReadBytes:value.kind==="page"?value.page.end-value.page.start:0},recordedAt:this.dependencies.now()};
  }
  async reconcile(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal):Promise<ActivityRawResult|null> {
    // These stages have no external effect; accepted pages are never dispatched again.
    return this.execute(path,stage,stage.attempt!,signal);
  }
  async interpret(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal) {
    signal.throwIfAborted();
    if(stage.result?.completeness!=="complete"||stage.result.outcome!=="returned")throw new TypeError("input_materialization_result_incomplete");
    const input=stageInput(stage),value=stage.result.value as MaterializationValue;
    const base={kind:"input_materialization" as const,stageId:stage.request.id,rawResultId:stage.result.id,pages:input.pages};
    if(value.kind==="gap")return {progress:{...base,state:"gap",reason:value.reason},next:[]};
    if(value.kind==="assembled") {
      // Retained pages, not a new read or a model request, reproduce the exact declaration.
      if(modelInputValueDigest(await this.assemble(path,input,signal))!==modelInputValueDigest(value.request))throw new TypeError("input_materialization_declaration_mismatch");
      return {progress:{...base,state:"organized",preparationPathId:input.request.preparationIntent.id},next:[],
        participants:this.dependencies.preparation.prepareSubmission(input.request.preparationIntent,value.request)};
    }
    if(value.kind!=="page")throw new TypeError("input_materialization_result_invalid");
    const pending=nextRead(input);
    if(!pending||value.accessId!==accessKey(pending.access))throw new TypeError("input_materialization_page_binding_invalid");
    validatePage(pending,value.page);
    const pages=[...input.pages,{accessId:value.accessId,start:value.page.start,end:value.page.end,stageId:stage.request.id,rawResultId:stage.result.id}];
    if(path.resourceUse.admittedStages>=path.intent.maximumStages||path.resourceUse.dispatchedAttempts>=path.intent.maximumAttempts||Date.parse(this.dependencies.now())>=Date.parse(path.intent.deadlineAt))
      return {progress:{...base,pages,state:"gap",reason:"input_materialization_execution_budget_exhausted"},next:[]};
    return {progress:{...base,pages,state:"reading"},next:[materializationStage(path.intent.id,path.progressRevision+2,{request:input.request,pages},[{requestId:stage.request.id,condition:"accepted"}])]};
  }
  async settle(_path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal) {
    signal.throwIfAborted();return {disposition:{kind:"retained_input_materialization_result",resultId:stage.result!.id,adopted:false}};
  }
  async result(pathId:string):Promise<{kind:"pending"|"cancelled"|"changed"}|{kind:"organized";preparationPathId:string}|{kind:"gap";reason:string}> {
    const read=()=>this.port.command({kind:"read_path",pathId}) as Promise<ActivityPathState|null>;
    const path=await read();if(!path||path.intent.purpose.digest!==this.purpose.digest)throw new TypeError("input_materialization_path_unavailable");
    if(path.cancelled)return {kind:"cancelled"};
    const progress=path.progress as MaterializationProgress|null;if(!progress)return {kind:"pending"};
    const stage=await this.port.command({kind:"read_stage",requestId:progress.stageId}) as ActivityStageState|null;
    if(!stage||stage.request.pathId!==pathId||stage.status!=="accepted"||!stage.receipt||!stage.result||stage.result.id!==progress.rawResultId||
      stage.receipt.expectedProgressRevision+1!==path.progressRevision||modelInputValueDigest(stage.receipt.progress)!==modelInputValueDigest(progress))throw new TypeError("input_materialization_acceptance_invalid");
    const latest=await read();if(!latest||latest.controlRevision!==path.controlRevision||latest.progressRevision!==path.progressRevision)return {kind:"changed"};
    if(progress.state==="organized"&&progress.preparationPathId)return {kind:"organized",preparationPathId:progress.preparationPathId};
    if(progress.state==="gap"&&progress.reason)return {kind:"gap",reason:progress.reason};
    if(progress.state==="reading")return {kind:"pending"};
    throw new TypeError("input_materialization_progress_invalid");
  }
  private async assemble(path:ActivityPathState,input:MaterializationStageInput,signal:AbortSignal):Promise<ContextInputPreparationRequest> {
    if(nextRead(input))throw new TypeError("input_materialization_pages_incomplete");
    const texts=new Map<string,string>();
    for(const access of accesses(input.request)) {
      const chunks:Buffer[]=[];
      for(const receipt of input.pages.filter(p=>p.accessId===accessKey(access))) {
        signal.throwIfAborted();
        const stage=await this.port.command({kind:"read_stage",requestId:receipt.stageId}) as ActivityStageState|null;
        const value=stage?.result?.value as MaterializationValue|undefined;
        if(!stage||stage.request.pathId!==path.intent.id||stage.status!=="accepted"||!stage.receipt||stage.receipt.resultId!==receipt.rawResultId||
          stage.result?.id!==receipt.rawResultId||value?.kind!=="page"||value.accessId!==receipt.accessId||
          modelInputValueDigest(stageInput(stage).request)!==modelInputValueDigest(input.request))throw new TypeError("input_materialization_page_evidence_invalid");
        validatePage({access,start:receipt.start,end:receipt.end},value.page);
        chunks.push(Buffer.from(value.page.bytesBase64,"base64"));
      }
      try {texts.set(accessKey(access),new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(Buffer.concat(chunks)));}
      catch {throw new TypeError("input_materialization_encoding_invalid");}
    }
    const demand:InputOrganizationDemand={...input.request.demand,contributions:input.request.demand.contributions.map(contribution=>({...contribution,
      options:contribution.options.map(option=>({...option,sections:option.sections.map(occurrence=>{
        const content=occurrence.section.content;
        const text=(part:Omit<RetainedInputText,"kind">)=>part.prefix+texts.get(accessKey(part.access))!+part.suffix;
        return {...occurrence,section:{...occurrence.section,content:content.kind==="retained_text"?
          {kind:"text" as const,text:text(content)}:content.kind==="retained_result_text"?
            {kind:"model_message" as const,message:fillModelResultTextSlots(content.message,content.replacements.map(r=>({slot:r.slot,text:text(r)})))}:content}};
      })}))}))};
    validateInputDemand(demand);
    const retained=new Map([...input.request.preparation.materialAccesses,...accesses(input.request)].map(access=>[accessKey(access),access]));
    return {...input.request.preparation,demand,materialAccesses:[...retained.values()]};
  }
}

function materializationStage(pathId:string,sequence:number,input:MaterializationStageInput,dependencies:ActivityStageRequest["dependencies"]):ActivityStageRequest {
  const reading=nextRead(input)!==null;
  return {id:`${pathId}:stage:${sequence}`,pathId,stageKind:reading?"read":"assemble",input,capabilities:reading?["material-read"]:[],dependencies};
}
function stageInput(stage:ActivityStageState):MaterializationStageInput {
  const input=stage.request.input as MaterializationStageInput;
  if(input?.request?.kind!=="context_input_materialization"||!Array.isArray(input.pages))throw new TypeError("input_materialization_stage_invalid");
  return input;
}
function accessKey(access:MaterialAccess):string {return modelInputValueDigest(access);}
function textParts(content:MaterialInputSection["content"]):readonly Omit<RetainedInputText,"kind">[] {
  return content.kind==="retained_text"?[content]:content.kind==="retained_result_text"?content.replacements:[];
}
function accesses(request:ContextInputMaterializationRequest):readonly MaterialAccess[] {
  return [...new Map(request.demand.contributions.flatMap(c=>c.options.flatMap(o=>o.sections.flatMap(s=>textParts(s.section.content).map(p=>p.access))))
    .map(access=>[accessKey(access),access])).values()];
}
function validateRequest(request:ContextInputMaterializationRequest):void {
  const {demand,preparation,preparationIntent}=request;
  // This validator checks organization metadata, not section content encoding.
  validateInputDemand(demand as InputOrganizationDemand);
  if(request.kind!=="context_input_materialization"||!Number.isSafeInteger(request.pageBytes)||request.pageBytes<1||request.pageBytes>65536||
    !Number.isSafeInteger(demand.maximumReadBytes)||demand.maximumReadBytes<0||preparation.kind!=="context_input_preparation"||preparation.template.purpose!==demand.purpose||
    preparation.policy.purpose!==demand.purpose||preparationIntent.runId!==demand.runId)throw new TypeError("input_materialization_request_invalid");
  let bytes=0;
  for(const contribution of demand.contributions)for(const option of contribution.options)for(const occurrence of option.sections) {
    const content=occurrence.section.content;
    if(content.kind==="retained_result_text") {
      if(occurrence.section.role!=="tool"||!Array.isArray(content.replacements)||!content.replacements.length)
        throw new TypeError("input_materialization_result_binding_invalid");
      fillModelResultTextSlots(content.message,content.replacements.map(r=>({slot:r.slot,text:""})));
    }
    for(const part of textParts(content))if(typeof part.prefix!=="string"||typeof part.suffix!=="string")
      throw new TypeError("input_materialization_text_binding_invalid");
  }
  for(const access of accesses(request)) {
    const r=access.range;
    if(access.recipient.runId!==demand.runId||access.recipient.recipient!==demand.recipient||access.recipient.purpose!==demand.purpose||
      !access.id||!access.holdId||!r.materialId||!r.version||r.coordinate!=="bytes"||!Number.isSafeInteger(r.start)||!Number.isSafeInteger(r.end)||r.start<0||r.end<r.start)
      throw new TypeError("input_materialization_material_scope_invalid");
    bytes+=r.end-r.start;
  }
  if(bytes>demand.maximumReadBytes)throw new TypeError("input_materialization_read_budget_exceeded");
}
function nextRead(input:MaterializationStageInput):{access:MaterialAccess;start:number;end:number}|null {
  const values=accesses(input.request),known=new Set(values.map(accessKey));
  if(input.pages.some(p=>!known.has(p.accessId))||new Set(input.pages.map(p=>p.stageId)).size!==input.pages.length)throw new TypeError("input_materialization_page_scope_invalid");
  let next:null|{access:MaterialAccess;start:number;end:number}=null;
  for(const access of values) {
    let offset=access.range.start;
    for(const page of input.pages.filter(p=>p.accessId===accessKey(access))) {
      if(page.start!==offset||page.end!==Math.min(offset+input.request.pageBytes,access.range.end)||page.end<=page.start)throw new TypeError("input_materialization_page_order_invalid");
      offset=page.end;
    }
    if(offset<access.range.end&&!next)next={access,start:offset,end:Math.min(offset+input.request.pageBytes,access.range.end)};
  }
  return next;
}
function validatePage(expected:{access:MaterialAccess;start:number;end:number},page:MaterialReadPage):void {
  if(!page||page.start!==expected.start||page.end!==expected.end||page.version.ref.materialId!==expected.access.range.materialId||
    page.version.ref.version!==expected.access.range.version||Buffer.from(page.bytesBase64,"base64").length!==page.end-page.start)
    throw new TypeError("input_materialization_page_mismatch");
}

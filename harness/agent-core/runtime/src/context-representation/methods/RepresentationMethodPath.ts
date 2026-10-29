import type {Provider,ProviderCallResult} from "@agent-anything/model-interaction";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {containsMaterialRange,type MaterialCustodyPort,type MaterialReadPage,type MaterialSearchPage,type MaterialHold,type MaterialAccess,type MaterialAccessDescription} from "@agent-anything/context/custody";
import type {RepresentationCatalogPort,RepresentationRecord,RepresentationJudgment,RepresentationLoss} from "@agent-anything/context/representation";
import type {ContextSelectionPort,ContextUseScope} from "@agent-anything/context/selection";
import type {ActivityPurposeHandler} from "../../activity/ActivityHandoffProcessor.js";
import type {ActivityPathState,ActivityStageState,ActivityStageRequest,ActivityAttempt,ActivityRawResult,ActivityHandoffPort} from "../../activity/ActivityHandoff.js";
import type {SharedAcceptancePart} from "../../activity/SharedAcceptance.js";
import {ContextInputPreparationHandler,firstContextInputPreparationStage,type PreparedContextInput,type ContextInputPreparationStageInput} from "../ContextInputPreparation.js";
import {PreparedInputExecution} from "../PreparedInputExecution.js";
import {contextInputAcceptance} from "../ContextInputAcceptance.js";
import {REPRESENTATION_METHOD_PURPOSE,validateRepresentationMethodRequest,type RepresentationMethodProgress,type MethodSource,type MethodJob,type MethodCandidate,type MethodAssessment} from "./RepresentationMethod.js";
import {createRepresentationMethodInput,type MethodEvidence} from "./RepresentationMethodInput.js";
import {parseRepresentationMethodOutput,representationAssessmentSupported,discoveredRelationships,RepresentationMethodResultError,type GeneratedRepresentation,type AssessedRepresentation} from "./RepresentationMethodOutput.js";
import {checkMethodAccess,stageMethodMaterial,originalMethodRepresentation} from "./RepresentationMethodResources.js";
import {initialMethodJobs,splitMethodJob,distributedMethodChecks,methodCandidateChecked,methodJobKey,nextMethodFinalJobs,methodCoverageGaps} from "./RepresentationMethodPlanning.js";
import {findMethodAssessmentReuse,methodAssessmentConditions} from "./RepresentationMethodReuse.js";
import {methodLineUnits,methodSources} from "./RepresentationMethodRanges.js";

export interface RepresentationMethodDependencies {
  readonly provider:Provider;
  readonly materials:MaterialCustodyPort;
  readonly representations:RepresentationCatalogPort;
  readonly selections:ContextSelectionPort;
  readonly activities:ActivityHandoffPort;
  readonly authorize:ActivityPurposeHandler["authorize"];
  readonly now:()=>string;
}
interface MethodLocalInput {readonly method:RepresentationMethodProgress;readonly source?:string;readonly offset?:number;readonly cursor?:string;readonly preparationStageId?:string;readonly variableRequest?:Parameters<typeof firstContextInputPreparationStage>[1];}
type Input=MethodLocalInput&Partial<ContextInputPreparationStageInput>;
type ReadValue={kind:"read";source:string;page:MaterialReadPage}|{kind:"search";source:string;page:MaterialSearchPage};
type BindValue={kind:"bind";prepared:PreparedContextInput;scope:ContextUseScope;judgment:RepresentationJudgment;selectionHolds:readonly MaterialHold[];inputHolds:readonly MaterialHold[];refs:readonly RepresentationRecord["ref"][]};
type Outcome=Awaited<ReturnType<ActivityPurposeHandler["interpret"]>>;
class MethodEvidenceUnavailable extends Error {}

/** Owns professional stages only. Durable activity control and shared acceptance remain outside it. */
export class RepresentationMethodPath implements ActivityPurposeHandler {
  private readonly preparation:ContextInputPreparationHandler;
  private readonly execution:PreparedInputExecution;
  constructor(private readonly ports:RepresentationMethodDependencies) {
    this.preparation=new ContextInputPreparationHandler({provider:ports.provider,materials:ports.materials,authorize:ports.authorize,now:ports.now,purpose:REPRESENTATION_METHOD_PURPOSE});
    this.execution=new PreparedInputExecution({provider:ports.provider,selections:ports.selections,inputId:stage=>`${stage.request.id}:input`,authorize:ports.authorize,now:ports.now,
      interpret:(path,stage,signal,acceptance)=>this.interpretModel(path,stage,signal,acceptance.id)});
  }
  async authorize(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal):Promise<void> {
    const method=this.state(path,stage);validateRepresentationMethodRequest(method.request);
    if(path.intent.purpose.digest!==modelInputValueDigest(REPRESENTATION_METHOD_PURPOSE)||path.intent.runId!==method.request.recipient.runId)throw new TypeError("representation_path_binding_invalid");
    if(method.request.combination) {
      const prepared=method.request.combination.prepared;
      const original=await this.ports.activities.command({kind:"read_stage",requestId:prepared.preparationStageId}) as ActivityStageState|null;
      if(original?.status!=="accepted"||modelInputValueDigest((original.receipt?.progress as {prepared?:PreparedContextInput})?.prepared)!==modelInputValueDigest(prepared))throw new TypeError("representation_combination_preparation_unconfirmed");
    }
    for(const source of method.request.sources){signal.throwIfAborted();await checkMethodAccess(this.ports.materials,source);}
    for(const access of method.request.dependencyAccesses??[]) {
      signal.throwIfAborted();const descriptor=await this.ports.materials.command({kind:"describe",holdId:access.holdId,recipient:access.recipient}) as MaterialAccessDescription;
      if(!containsMaterialRange(descriptor.hold.range,access.range))throw new TypeError("representation_dependency_unavailable");
    }
    for(const candidate of method.candidates) {
      signal.throwIfAborted();await checkMethodAccess(this.ports.materials,this.candidateSource(candidate,method));
    }
    if(stage.request.stageKind==="model")await this.execution.authorize(path,stage,signal);
    else if(["organize","measure"].includes(stage.request.stageKind))await this.preparation.authorize(path,stage,signal);
    else await this.ports.authorize(path,stage,signal);
  }
  async execute(path:ActivityPathState,stage:ActivityStageState,attempt:ActivityAttempt,signal:AbortSignal):Promise<ActivityRawResult> {
    const started=performance.now();
    try {return await this.executeStage(path,stage,attempt,signal);}
    catch(error) {
      if(!(error instanceof MethodEvidenceUnavailable)&&!this.resourceExhausted(error))throw error;
      return {id:`${attempt.id}:raw`,attemptId:attempt.id,completeness:"complete",outcome:"returned",value:{kind:"gap",code:error.message},usage:{localMs:performance.now()-started},recordedAt:this.ports.now()};
    }
  }
  private async executeStage(path:ActivityPathState,stage:ActivityStageState,attempt:ActivityAttempt,signal:AbortSignal):Promise<ActivityRawResult> {
    if(stage.request.stageKind==="model") {
      await this.reserve(path,stage,"model",{modelCalls:1});
      return this.execution.execute(path,stage,attempt,signal);
    }
    if(["organize","measure"].includes(stage.request.stageKind)) {
      if(stage.request.stageKind==="measure")await this.reserve(path,stage,"measurement",{measurementCalls:1});
      return this.preparation.execute(path,stage,attempt,signal);
    }
    signal.throwIfAborted();const started=performance.now(),method=this.state(path,stage),input=stage.request.input as Input;
    let value:unknown;
    if(stage.request.stageKind==="read") {
      const source=method.request.sources.find(s=>s.alias===input.source)!;
      const descriptor=await checkMethodAccess(this.ports.materials,source);
      if(!["utf8","json"].includes(descriptor.version.format))throw new MethodEvidenceUnavailable("representation_text_method_unsupported");
      const remaining=method.request.bounds.readBytes-method.readBytes,offset=input.offset??source.access.range.start;
      if(remaining<=0&&offset<source.access.range.end)value={kind:"gap",code:"representation_read_budget_exhausted"};
      else if(method.request.method==="search"&&source.role==="source") {
        await this.reserve(path,stage,"source-read",{readBytes:Math.min(method.request.bounds.pageBytes,remaining,source.access.range.end-offset)});
        const page=await this.ports.materials.command({kind:"search",request:{...source.access,...method.request.search!,scanBytes:Math.min(method.request.bounds.pageBytes,remaining),...(input.cursor?{cursor:input.cursor}:{})}}) as MaterialSearchPage;
        value={kind:"search",source:source.alias,page} satisfies ReadValue;
      } else {
        await this.reserve(path,stage,"source-read",{readBytes:Math.min(method.request.bounds.pageBytes,remaining,source.access.range.end-offset)});
        const page=await this.ports.materials.command({kind:"read",access:source.access,offset,length:Math.min(method.request.bounds.pageBytes,remaining,source.access.range.end-offset)}) as MaterialReadPage;
        value={kind:"read",source:source.alias,page} satisfies ReadValue;
      }
    } else if(stage.request.stageKind==="assemble") {
      const reuse=await findMethodAssessmentReuse(this.ports.representations,this.ports.activities,method.request,method.current!,this.inputSources(method,method.current!),signal);
      if(reuse)return {id:`${attempt.id}:raw`,attemptId:attempt.id,completeness:"complete",outcome:"returned",value:{kind:"reused_assessment",...reuse},usage:{localMs:performance.now()-started},recordedAt:this.ports.now()};
      const size=this.inputSources(method,method.current!).reduce((n,s)=>n+s.access.range.end-s.access.range.start,0);
      if(size>method.request.bounds.readBytes-method.readBytes)return {id:`${attempt.id}:raw`,attemptId:attempt.id,completeness:"complete",outcome:"returned",value:{kind:"gap",code:"representation_read_budget_exhausted"},usage:{localMs:performance.now()-started},recordedAt:this.ports.now()};
      await this.reserve(path,stage,"evidence-read",{readBytes:size});
      const evidence=await this.evidence(method,method.current!,signal);
      const readBytes=evidence.reduce((sum,e)=>sum+Buffer.byteLength(e.text,"utf8"),0);
      if(method.readBytes+readBytes>method.request.bounds.readBytes)value={kind:"gap",code:"representation_read_budget_exhausted"};
      else value={kind:"assembled",readBytes,request:{...createRepresentationMethodInput(method.request,method.current!,evidence,stage.attempt!.startedAt),
        materialAccesses:[...this.inputSources(method,method.current!).map(s=>s.access),...(method.request.dependencyAccesses??[])]},
        fixedRequest:{...createRepresentationMethodInput(method.request,method.current!,evidence.filter(e=>e.role==="background"),stage.attempt!.startedAt),materialAccesses:method.request.sources.filter(s=>s.role==="background").map(s=>s.access)}};
    } else if(stage.request.stageKind==="bind") {
      value=await this.bindValue(path,stage,method,input.preparationStageId!,signal);
    } else if(stage.request.stageKind==="exact") {
      if(method.request.method!=="preserve")await this.reserve(path,stage,"exact-read",{readBytes:method.request.sources.filter(s=>s.role==="source").reduce((n,s)=>n+s.access.range.end-s.access.range.start,0)});
      value={kind:"exact",evidence:method.request.method==="preserve"?[]:await this.originalEvidence(method,method.request.sources.filter(s=>s.role==="source").map(s=>s.alias),signal)};
    } else if(stage.request.stageKind==="ranges") {
      const size=method.request.sources.filter(s=>s.division).reduce((sum,s)=>sum+s.access.range.end-s.access.range.start,0);
      if(size>method.request.bounds.readBytes-method.readBytes)return {id:`${attempt.id}:raw`,attemptId:attempt.id,completeness:"complete",outcome:"returned",value:{kind:"gap",code:"representation_read_budget_exhausted"},usage:{localMs:performance.now()-started},recordedAt:this.ports.now()};
      await this.reserve(path,stage,"range-read",{readBytes:size});
      const evidence=await this.originalEvidence(method,method.request.sources.filter(s=>s.division).map(s=>s.alias),signal);
      const units=evidence.flatMap(e=>methodLineUnits(method.request.sources.find(s=>s.alias===e.alias)!,e.text,method.request.bounds.pageBytes));
      value=units.length>method.request.bounds.ranges?{kind:"gap",code:"representation_range_budget_exhausted"}:{kind:"ranges",units,readBytes:size};
    } else throw new TypeError("representation_stage_unsupported");
    return {id:`${attempt.id}:raw`,attemptId:attempt.id,completeness:"complete",outcome:"returned",value,usage:{localMs:performance.now()-started},recordedAt:this.ports.now()};
  }
  async reconcile(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal):Promise<ActivityRawResult|null> {
    if(stage.request.stageKind==="model"||stage.request.stageKind==="measure")return null;
    // Only bounded reads/computation and identity-idempotent local staging are recalculated.
    return this.execute(path,stage,stage.attempt!,signal);
  }
  async interpret(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal,acceptance:{id:string}):Promise<Outcome> {
    let outcome:Outcome;
    try {outcome=await this.interpretStage(path,stage,signal,acceptance);}
    catch(error) {
      if(!this.resourceExhausted(error))throw error;
      return this.gap(this.state(path,stage),stage,"representation_shared_allowance_exhausted",{code:(error as Error).message});
    }
    if(outcome.next.length&&!this.hasStageRoom(path)) {
      const method=(outcome.progress as {method:RepresentationMethodProgress}).method;
      return {...this.gap(method,stage,"representation_execution_budget_exhausted",{resources:path.resourceUse}),participants:outcome.participants};
    }
    return outcome;
  }
  private async interpretStage(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal,acceptance:{id:string}):Promise<Outcome> {
    if((stage.result?.value as {kind?:string;code?:string}|undefined)?.code==="activity_resource_limit_exceeded")return this.gap(this.state(path,stage),stage,"representation_shared_allowance_exhausted",stage.result!.value);
    if(stage.request.stageKind==="model")return this.execution.interpret(path,stage,signal,acceptance);
    const method=this.state(path,stage);signal.throwIfAborted();
    if(!stage.result||stage.result.completeness!=="complete"||stage.result.outcome!=="returned")return this.gap(method,stage,"representation_stage_result_incomplete",stage.result);
    if(["organize","measure"].includes(stage.request.stageKind)) {
      const variableRequest=(stage.request.input as Input).variableRequest;
      const result=await this.preparation.interpret(path,stage,signal),progress=result.progress as {state:string;prepared?:PreparedContextInput;reason?:string};
      if(progress.state==="gap") {
        if(variableRequest)return this.gap(method,stage,"representation_fixed_background_unavailable",result.progress);
        const split=splitMethodJob(method,method.current!);
        if(split)return this.schedule(path,stage,{...method,current:null,queue:[...split,...method.queue]});
        const checks=distributedMethodChecks(method,method.current!);
        if(checks)return this.schedule(path,stage,{...method,current:null,queue:[...checks,...method.queue],checkGroups:[...method.checkGroups,{candidateId:method.current!.candidates[0]!,jobs:checks.map(j=>j.id)}]});
        return this.gap(method,stage,"representation_input_unavailable",result.progress);
      }
      if(progress.state==="prepared") {
        if(variableRequest) {
          const first=firstContextInputPreparationStage(path.intent.id,variableRequest);
          return {progress:{...progress,method},next:[this.nextStage(path,stage,"organize",{...(first.input as object),method})]};
        }
        return {progress:{...progress,method},next:[this.nextStage(path,stage,"bind",{method,preparationStageId:stage.request.id})]};
      }
      return {progress:{...progress,method},next:result.next.map(next=>({...next,input:{...(next.input as object),method,...(variableRequest?{variableRequest}:{})}}))};
    }
    const value=stage.result.value as {kind:string;code?:string};
    if(value.kind==="gap")return this.gap(method,stage,value.code!,value);
    if(value.kind==="reused_assessment")return this.afterAssessment(path,stage,method,(value as {kind:string;output:AssessedRepresentation}).output,acceptance.id);
    if(value.kind==="read"||value.kind==="search")return this.afterRead(path,stage,method,value as ReadValue);
    if(value.kind==="ranges") {
      const ranges=value as {kind:string;units:RepresentationMethodProgress["rangeUnits"];readBytes:number};
      const next={...method,rangeUnits:ranges.units,readBytes:method.readBytes+ranges.readBytes};
      return this.schedule(path,stage,{...next,queue:initialMethodJobs(path.intent.id,next)});
    }
    if(value.kind==="exact")return this.afterExact(path,stage,method,(value as {kind:string;evidence:MethodEvidence[]}).evidence,signal,acceptance.id);
    if(value.kind==="assembled") {
      if(method.modelCalls>=method.request.bounds.modelCalls)return this.gap(method,stage,"representation_model_budget_exhausted",{used:method.modelCalls});
      const request=(value as {kind:string;request:Parameters<typeof firstContextInputPreparationStage>[1]}).request;
      const fixed=(value as {kind:string;fixedRequest:Parameters<typeof firstContextInputPreparationStage>[1]}).fixedRequest;
      const first=firstContextInputPreparationStage(path.intent.id,fixed);
      const updated={...method,readBytes:method.readBytes+(value as {kind:string;readBytes:number}).readBytes};
      const next=this.nextStage(path,stage,"organize",{...(first.input as object),method:updated,variableRequest:request});
      return {progress:{method:updated},next:[next]};
    }
    if(value.kind==="bind") {
      if(!this.hasStageRoom(path))return this.gap(method,stage,"representation_execution_budget_exhausted",{resources:path.resourceUse});
      const bound=value as BindValue,modelId=`${method.current!.id}:dispatch`,inputId=`${modelId}:input`,selectionId=`${modelId}:selection`;
      const proposal=contextInputAcceptance({id:acceptance.id,scope:bound.scope,expectedSelectionId:null,expectedControlRevision:0,
        selection:{id:selectionId,representations:bound.refs,judgmentIds:[bound.judgment.id],holds:bound.selectionHolds},retainedSelectionId:null,prepared:bound.prepared,judgment:bound.judgment,
        inputId,activityId:path.intent.id,stageRequestId:modelId,stageKind:"model",capabilities:["model-access"],inputHolds:bound.inputHolds,releaseHolds:[]});
      const next={...method,modelCalls:method.modelCalls+1,acceptedInputs:[...method.acceptedInputs,{inputId,scopeId:bound.scope.id,selectionId,holds:[...bound.selectionHolds,...bound.inputHolds].map(h=>h.id)}]};
      return {progress:{method:next},next:[],participants:proposal.parts};
    }
    throw new TypeError("representation_stage_result_invalid");
  }

  private afterRead(path:ActivityPathState,stage:ActivityStageState,method:RepresentationMethodProgress,value:ReadValue):Outcome {
    const source=method.request.sources.find(s=>s.alias===value.source)!;
    const start=value.kind==="read"?value.page.start:value.page.scanned.start,end=value.kind==="read"?value.page.end:value.page.scanned.end;
    if(start<source.access.range.start||end>source.access.range.end||end<start||end===start&&end<source.access.range.end)throw new TypeError("representation_read_progress_invalid");
    const next={...method,readBytes:method.readBytes+end-start,pages:[...method.pages,{alias:source.alias,start,end,stageId:stage.request.id}]};
    if(next.readBytes>method.request.bounds.readBytes)throw new TypeError("representation_read_budget_invalid");
    if(value.kind==="read"&&value.page.next!==null)return {progress:{method:next},next:[this.nextStage(path,stage,"read",{method:next,source:source.alias,offset:value.page.next})]};
    if(value.kind==="search"&&value.page.stop==="scan_budget"&&value.page.next!==null)return {progress:{method:next},next:[this.nextStage(path,stage,"read",{method:next,source:source.alias,cursor:value.page.next,offset:end})]};
    const index=method.request.sources.findIndex(s=>s.alias===source.alias),following=method.request.sources[index+1];
    if(following)return {progress:{method:next},next:[this.nextStage(path,stage,"read",{method:next,source:following.alias,offset:following.access.range.start})]};
    if(["preserve","excerpt","omit","search"].includes(method.request.method))return {progress:{method:next},next:[this.nextStage(path,stage,"exact",{method:next})]};
    if(method.request.sources.some(s=>s.division))return {progress:{method:next},next:[this.nextStage(path,stage,"ranges",{method:next})]};
    return this.schedule(path,stage,{...next,queue:initialMethodJobs(path.intent.id,next)});
  }
  private async originalEvidence(method:RepresentationMethodProgress,aliases:readonly string[],signal:AbortSignal):Promise<MethodEvidence[]> {
    const result:MethodEvidence[]=[];
    for(const alias of aliases) {
      const source=methodSources(method).find(s=>s.alias===alias);if(!source)throw new TypeError("representation_read_source_missing");
      const originalAlias=method.rangeUnits.find(u=>u.source.alias===alias)?.originalAlias??alias;
      const pages=method.pages.filter(p=>p.alias===originalAlias&&p.end>source.access.range.start&&p.start<source.access.range.end||p.alias===originalAlias&&source.access.range.start===source.access.range.end).sort((a,b)=>a.start-b.start),buffers:Buffer[]=[],search:MaterialSearchPage[]=[];
      let offset=source.access.range.start;
      for(const page of pages) {
        signal.throwIfAborted();const start=Math.max(page.start,source.access.range.start),end=Math.min(page.end,source.access.range.end);if(start!==offset)throw new TypeError("representation_read_coverage_gap");offset=end;
        const record=await this.ports.activities.command({kind:"read_stage",requestId:page.stageId}) as ActivityStageState;
        if(record?.status!=="accepted"||!record.result)throw new TypeError("representation_read_unconfirmed");
        const value=record.result.value as ReadValue;
        if(value.kind==="read")buffers.push(Buffer.from(value.page.bytesBase64,"base64").subarray(start-page.start,end-page.start));else search.push(value.page);
      }
      const descriptor=await checkMethodAccess(this.ports.materials,source);
      let text:string,limitations=[...descriptor.version.limitations,...(descriptor.version.capture!=="complete"?[`source capture: ${descriptor.version.capture}`]:[])];
      if(search.length) {text=JSON.stringify({query:method.request.search,pages:search});if(!search.at(-1)!.complete)limitations.push("search incomplete: continuation preserved");}
      else {
        if(offset!==source.access.range.end)throw new TypeError("representation_read_incomplete");
        if(!["utf8","json"].includes(descriptor.version.format))throw new MethodEvidenceUnavailable("representation_text_method_unsupported");
        try {text=new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(buffers));}
        catch {throw new MethodEvidenceUnavailable("representation_text_encoding_invalid");}
      }
      if(originalAlias!==alias)limitations.push(`Partial range of ${originalAlias}; line boundaries do not establish semantic independence`);
      result.push({alias,role:source.role,originalRole:source.originalRole,order:source.order,label:source.label,text,limitations,sourceRange:source.access.range});
    }
    return result;
  }
  private async evidence(method:RepresentationMethodProgress,job:MethodJob,signal:AbortSignal):Promise<MethodEvidence[]> {
    const original=methodSources(method).filter(s=>s.role==="background"||job.sources.includes(s.alias)||job.candidates.includes(s.alias));
    const result=await this.originalEvidence(method,original.map(s=>s.alias),signal);
    for(const id of [...new Set([...job.sources,...job.candidates])]) {
      if(original.some(s=>s.alias===id))continue;
      const candidate=method.candidates.find(c=>c.id===id||c.segments.some(s=>s.id===id));if(!candidate)throw new TypeError("representation_candidate_missing");
      const access={...candidate.access,range:candidate.segments.find(s=>s.id===id)?.range??candidate.access.range};
      const buffers:Buffer[]=[];
      for(let offset=access.range.start;offset<access.range.end;) {
        signal.throwIfAborted();const page=await this.ports.materials.command({kind:"read",access,offset,length:Math.min(65536,access.range.end-offset)}) as MaterialReadPage;
        buffers.push(Buffer.from(page.bytesBase64,"base64"));if(page.end<=offset)throw new TypeError("representation_candidate_read_stalled");offset=page.end;
      }
      result.push({alias:id,role:job.candidates.includes(id)?"candidate":"source",originalRole:"derived_representation",order:result.length+method.request.sources.length,label:id,text:new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(buffers)),limitations:[...candidate.losses.map(l=>l.description),...candidate.unknowns.map(u=>`${u.kind}: ${u.description}`),...(id!==candidate.id?[`Candidate part, bytes ${access.range.start}-${access.range.end}; not the entire candidate`]:[])]});
    }
    return result;
  }
  private async bindValue(path:ActivityPathState,stage:ActivityStageState,method:RepresentationMethodProgress,preparationId:string,signal:AbortSignal):Promise<BindValue> {
    const preparation=await this.ports.activities.command({kind:"read_stage",requestId:preparationId}) as ActivityStageState;
    const prepared=(preparation?.receipt?.progress as {prepared?:PreparedContextInput})?.prepared;
    if(preparation?.status!=="accepted"||!prepared)throw new TypeError("representation_preparation_unaccepted");
    const job=method.current!,modelId=`${job.id}:dispatch`;
    const scope:ContextUseScope={...method.request.recipient,id:`${job.id}:scope`,continuity:job.id,owner:method.request.recipient.recipient,target:method.request.targetRevision,authorityBasis:path.intent.permissionBasis};
    await this.ports.selections.command({kind:"scope",scope});
    const inputs=this.inputSources(method,job),records:RepresentationRecord[]=[];
    for(const source of inputs){signal.throwIfAborted();records.push(await originalMethodRepresentation(method.request,source,this.ports.representations));}
    const refs=[...new Map(records.map(r=>[modelInputValueDigest(r.ref),r.ref])).values()];
    const ranges=[...new Map(records.flatMap(r=>[r.body,...r.details,...r.inputs.map(i=>i.material)]).map(r=>[modelInputValueDigest(r),r])).values()];
    const descriptions=await this.accessDescriptions(method);
    const holds=(responsibility:"input"|"selection")=>ranges.map((range,index)=>{
      const descriptor=descriptions.find(d=>containsMaterialRange(d.hold.range,range));if(!descriptor)throw new TypeError("representation_input_dependency_unavailable");
      const basis=`${modelId}:${responsibility}`;
      return {id:`${basis}:hold:${index}`,instanceId:descriptor.hold.instanceId,consumer:method.request.recipient,responsibility,range,basis,releaseCondition:"auxiliary input settled and method release"};
    });
    const judgment:RepresentationJudgment={id:`${job.id}:input-structure`,owner:scope.owner,kind:"combination",subjects:refs,inputs:ranges,purpose:scope.purpose,target:scope.target,
      methodRevision:"auxiliary-evidence-input:1",dependencies:{inputDigest:modelInputValueDigest(prepared),job:methodJobKey(job)},coverage:ranges,conclusion:"supported",
      limitations:["Suitability for the auxiliary investigation only; candidate semantics are NOT accepted for task use"],basis:"Exact authorized evidence, read-only background, fixed method and output contract; candidate is untrusted data"};
    await this.ports.representations.command({kind:"judge",judgment});
    return {kind:"bind",prepared,scope,judgment,selectionHolds:holds("selection"),inputHolds:holds("input"),refs};
  }
  private async interpretModel(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal,acceptanceId:string):Promise<Outcome> {
    const method=this.state(path,stage),job=method.current!;
    if(!stage.result||stage.result.outcome!=="returned"||stage.result.completeness!=="complete")return this.gap(method,stage,"representation_model_result_incomplete",stage.result);
    let output:GeneratedRepresentation|AssessedRepresentation;
    try {output=parseRepresentationMethodOutput(stage.result.value as ProviderCallResult,this.expandedRequest(method,job),job);}
    catch(error) {
      if(!(error instanceof RepresentationMethodResultError))throw error;
      if(error.code.startsWith("representation_output_")&&job.repair<method.request.bounds.repairs) {
        const retry={...job,id:`${job.id}:repair:${job.repair+1}`,repair:job.repair+1,feedback:JSON.stringify({previous:stage.result.id,error:error.code,details:error.details})};
        return this.schedule(path,stage,{...method,current:null,queue:[retry,...method.queue]});
      }
      return this.gap(method,stage,error.code,{rawResultId:stage.result.id,details:error.details});
    }
    if(output.kind==="candidate")return this.afterCandidate(path,stage,method,output,signal,acceptanceId);
    return this.afterAssessment(path,stage,method,output,acceptanceId);
  }
  private async afterCandidate(path:ActivityPathState,stage:ActivityStageState,method:RepresentationMethodProgress,output:GeneratedRepresentation,signal:AbortSignal,acceptanceId:string):Promise<Outcome> {
    const job=method.current!;
    if(Buffer.byteLength(output.body,"utf8")>method.request.bounds.storedBytes-method.storedBytes)return this.gap(method,stage,"representation_storage_budget_exhausted",{rawResultId:stage.result!.id});
    const artifact=await this.candidateArtifact(path,stage,method,job,output,signal,acceptanceId);
    const candidate=artifact.candidate;
    const check:MethodJob={id:`${job.id}:check`,kind:"check",sources:job.sources,candidates:[candidate.id],level:job.level,repair:job.repair,feedback:null};
    const next={...method,candidates:[...method.candidates,candidate],storedBytes:method.storedBytes+artifact.bytes,current:null,queue:[check,...method.queue]};
    if(output.missing.length||output.unknowns.some(u=>u.kind==="preservation_gap")) {
      const feedback=JSON.stringify({missing:output.missing,unknowns:output.unknowns});
      const retry={...job,id:`${job.id}:repair:${job.repair+1}`,repair:job.repair+1,feedback};
      return {...(job.repair<method.request.bounds.repairs?this.schedule(path,stage,{...next,queue:[retry,...method.queue]}):this.gap(next,stage,"representation_generation_gap",{missing:output.missing,unknowns:output.unknowns})),participants:artifact.parts};
    }
    const outcome=this.schedule(path,stage,next);
    return {...outcome,participants:artifact.parts};
  }
  private async candidateArtifact(path:ActivityPathState,stage:ActivityStageState,method:RepresentationMethodProgress,job:MethodJob,output:GeneratedRepresentation,signal:AbortSignal,acceptanceId:string) {
    signal.throwIfAborted();
    const id=`candidate_${modelInputValueDigest(job.id).replace("sha256:","").slice(0,24)}`;
    const materialId=`${path.intent.id}:${id}`,request=method.request;
    await this.reserve(path,stage,`material:${materialId}`,{storedBytes:Buffer.byteLength(output.body,"utf8")});
    const staged=await stageMethodMaterial({materials:this.ports.materials,request,id:materialId,pathId:path.intent.id,recordId:stage.result!.id,text:output.body,
      remainingBytes:request.bounds.storedBytes-method.storedBytes,occurredAt:stage.result!.recordedAt});
    const sources=this.inputSources(method,job),records:RepresentationRecord[]=[];
    for(const source of sources)records.push(await originalMethodRepresentation(request,source,this.ports.representations));
    const inherited=records.filter((_r,index)=>sources[index]!.role==="source").flatMap(r=>r.losses);
    const losses:RepresentationLoss[]=[...new Map(inherited.map(l=>[l.id,l])).values(),...output.losses.map((loss,index)=>({id:`${materialId}:loss:${index}`,source:sources.find(s=>s.alias===loss.source)!.access.range,kind:loss.kind,description:loss.description,basis:stage.result!.id}))];
    const details=[...new Map([...sources.filter(s=>s.role==="source").map(s=>s.access.range),...records.flatMap(r=>r.details)].map(range=>[modelInputValueDigest(range),range])).values()];
    const descriptions=await this.accessDescriptions(method);
    const dependencyHolds=[...new Set([...sources.map(s=>s.access.range),...details].map(range=>{
      const description=descriptions.find(d=>containsMaterialRange(d.hold.range,range));
      if(!description)throw new TypeError("representation_candidate_dependency_unavailable");
      return description.hold.id;
    }))];
    const record:RepresentationRecord={ref:{id:materialId,revision:"1"},owner:request.recipient.recipient,runId:request.recipient.runId,form:request.method==="detail"?"detail_bundle":"summary",body:staged.access.range,
      purpose:request.recipient.purpose,target:request.targetRevision,inputs:sources.map((s,index)=>({role:s.role==="background"?"background":"source",material:s.access.range,representation:s.representation===null?null:records[index]!.ref})),
      declaredCoverage:sources.filter(s=>s.role==="source").map(s=>s.access.range),details,holds:[staged.hold.id,...dependencyHolds],requirements:request.requirements,losses,restorations:[],
      method:{id:request.method,revision:request.methodRevision,activityId:path.intent.id,rawResultId:stage.result!.id,acceptanceId}};
    let offset=0;
    const segments=output.parts.map((part,index)=>{const start=offset,end=start+Buffer.byteLength(part.text,"utf8");offset=end+2;return {id:`${id}_s${index}`,range:{...staged.access.range,start,end},sources:part.sources};});
    const candidate:MethodCandidate={id,representation:record.ref,access:staged.access,sources:job.sources,losses,relationships:discoveredRelationships(materialId,output),unknowns:output.unknowns,generatedBy:job.id,level:job.level,segments};
    return {candidate,bytes:staged.bytes,parts:[...staged.parts,{owner:"representation",kind:"record",proposal:record}] satisfies SharedAcceptancePart[]};
  }
  private async reserve(path:ActivityPathState,stage:ActivityStageState,label:string,amounts:Readonly<Record<string,number>>):Promise<void> {
    await this.ports.activities.command({kind:"reserve_resources",reservation:{id:`${stage.request.id}:allowance:${label}`,pathId:path.intent.id,requestId:stage.request.id,amounts},expectedControlRevision:path.controlRevision});
  }
  private resourceExhausted(error:unknown):error is Error&{code:"activity_resource_limit_exceeded"} {return error instanceof Error&&"code" in error&&error.code==="activity_resource_limit_exceeded";}
  private async afterAssessment(path:ActivityPathState,stage:ActivityStageState,method:RepresentationMethodProgress,output:AssessedRepresentation,acceptanceId:string):Promise<Outcome> {
    const job=method.current!,supported=representationAssessmentSupported(output,job.checkScope??"both"),subjects:RepresentationRecord["ref"][]=[];
    for(const source of this.inputSources(method,job).filter(s=>job.candidates.includes(s.alias)))subjects.push((await originalMethodRepresentation(method.request,source,this.ports.representations)).ref);
    const ranges=this.inputSources(method,job).map(s=>s.access.range);
    const combination=job.kind==="combination"?method.request.combination:null;
    const judgment:RepresentationJudgment={id:`${job.id}:judgment`,owner:method.request.recipient.recipient,kind:job.kind==="combination"?"combination":"semantic",subjects:combination?.subjects??subjects,
      inputs:ranges,purpose:combination?.scope.purpose??method.request.recipient.purpose,target:combination?.scope.target??method.request.targetRevision,methodRevision:"bidirectional:1",dependencies:{method:method.request.methodRevision,job:methodJobKey(job),conditions:methodAssessmentConditions(method.request,job,this.inputSources(method,job)),
        ...((stage.result!.value as {kind?:string}).kind==="reused_assessment"?{reusedJudgment:(stage.result!.value as {judgmentId:string}).judgmentId}:{}),
        stage:stage.request.id,rawResult:stage.result!.id,acceptance:acceptanceId,...(method.request.combinationDigest?{inputDigest:method.request.combinationDigest}:{})},coverage:ranges,conclusion:supported?"supported":output.findings.some(f=>f.conclusion==="unsupported")||output.requirements.some(r=>r.conclusion==="unsupported")?"unsupported":"unknown",
      limitations:[...(job.checkScope?[`Only ${job.checkScope}-directed coverage; not whole-candidate or combination approval`]:[]),...output.findings.flatMap(f=>f.unknowns.map(u=>`${u.kind}: ${u.description}`))],basis:"Independent scoped findings in the referenced professional acceptance; not a proof of unexamined semantics"};
    const assessment:MethodAssessment={id:judgment.id,jobId:job.id,candidateIds:job.candidates,sourceAliases:job.sources,findings:output.findings,requirements:output.requirements,supported,rawResultId:stage.result!.id,judgmentIds:[judgment.id],scope:job.checkScope??"both"};
    let next:RepresentationMethodProgress={...method,assessments:[...method.assessments,assessment],current:null};
    const parts:SharedAcceptancePart[]=[{owner:"representation",kind:"judge",proposal:judgment}];
    if(!supported) {
      if(job.kind==="check"&&!job.checkScope&&!["check","check_combination"].includes(method.request.method)&&job.repair<method.request.bounds.repairs) {
        const repair:MethodJob={...job,id:`${job.id}:repair:${job.repair+1}`,kind:"generate",candidates:[],repair:job.repair+1,feedback:JSON.stringify(output)};
        return {...this.schedule(path,stage,{...next,queue:[repair,...next.queue]}),participants:parts};
      }
      return {...this.gap(next,stage,"representation_preservation_unconfirmed",output),participants:parts};
    }
    if(["check","check_combination"].includes(method.request.method))return {progress:{method:{...next,state:"ready"}},next:[],participants:parts};
    if(job.kind==="check") {
      const candidate=next.candidates.find(c=>c.id===job.candidates[0])??next.candidates.find(c=>next.checkGroups.some(g=>g.candidateId===c.id&&g.jobs.includes(job.id)));
      if(!candidate||!methodCandidateChecked(next,candidate.id))return {...this.schedule(path,stage,next),participants:parts};
      if(!job.checkScope&&method.request.method==="restore"&&(method.request.restorations?.length??0)>0) {
        const record=await this.ports.representations.command({kind:"read",ref:candidate.representation}) as RepresentationRecord;
        const restorations=method.request.restorations!.filter(r=>record.losses.some(l=>l.id===r.lossId)&&ranges.some(range=>containsMaterialRange(range,r.range)));
        if(restorations.length!==method.request.restorations!.length)return {...this.gap(next,stage,"representation_restoration_evidence_incomplete",{judgmentId:judgment.id}),participants:parts};
        const ref={id:record.ref.id,revision:`${record.ref.revision}:restored`};
        const restored:RepresentationRecord={...record,ref,inputs:[{role:"source",material:record.body,representation:record.ref},...record.inputs],
          restorations:[...record.restorations,...restorations.map(r=>({lossId:r.lossId,range:r.range,judgmentId:judgment.id}))],
          method:{id:"precision-restoration",revision:method.request.methodRevision,activityId:path.intent.id,rawResultId:stage.result!.id,acceptanceId}};
        parts.push({owner:"representation",kind:"record",proposal:restored});
        next={...next,candidates:next.candidates.map(c=>c.id===candidate.id?{...c,representation:ref}:c)};
      }
      const parents=next.candidates.filter(c=>candidate.sources.includes(c.id));
      if(parents.length>1&&candidate.access.range.end>=parents.reduce((sum,c)=>sum+c.access.range.end-c.access.range.start,0))return {...this.gap(next,stage,"representation_merge_not_improving",{retained:parents.map(c=>c.id),candidate:candidate.id}),participants:parts};
      next={...next,resultIds:[...new Set([...next.resultIds.filter(id=>!candidate.sources.includes(id)),candidate.id])]};
    }
    if(job.kind==="combination")return {progress:{method:{...next,state:"ready"}},next:[],participants:parts};
    return {...this.schedule(path,stage,next),participants:parts};
  }
  private async afterExact(path:ActivityPathState,stage:ActivityStageState,method:RepresentationMethodProgress,evidence:readonly MethodEvidence[],signal:AbortSignal,acceptanceId:string):Promise<Outcome> {
    let next=method;const parts:SharedAcceptancePart[]=[];
    if(method.request.method==="preserve") {
      const candidates:MethodCandidate[]=[];
      for(const source of method.request.sources.filter(s=>s.role==="source")) {
        signal.throwIfAborted();const record=await originalMethodRepresentation(method.request,source,this.ports.representations);
        candidates.push({id:source.alias,representation:record.ref,access:source.access,sources:[source.alias],losses:record.losses,relationships:[],unknowns:[],generatedBy:stage.request.id,level:0,segments:[]});
      }
      return {progress:{method:{...next,state:"ready",candidates,resultIds:candidates.map(c=>c.id)}},next:[]};
    }
    for(const item of evidence) {
      const job:MethodJob={id:`${stage.request.id}:${item.alias}`,kind:"generate",sources:[item.alias],candidates:[],level:0,repair:0,feedback:null};
      const text=method.request.method==="omit"?method.request.omission!.body:item.text;
      const output:GeneratedRepresentation={kind:"candidate",body:text,parts:[{text,sources:[item.alias]}],covered:[item.alias],background:[],losses:method.request.method==="omit"?[{source:item.alias,kind:"omitted",description:method.request.omission!.basis}]:method.request.method==="search"?[{source:item.alias,kind:"omitted",description:"Search result contains matched locations and explicit scan completeness, not all source content"}]:[],relationships:[],unknowns:item.limitations.map(description=>({kind:"source",source:item.alias,description})),missing:[]};
      if(Buffer.byteLength(text,"utf8")>next.request.bounds.storedBytes-next.storedBytes)return this.gap(method,stage,"representation_storage_budget_exhausted",{rawResultId:stage.result!.id});
      const artifact=await this.candidateArtifact(path,stage,next,job,output,signal,acceptanceId);
      const record=(artifact.parts.at(-1)!.proposal as RepresentationRecord);
      const coverage=method.request.method==="search"?method.pages.filter(p=>p.alias===item.alias).map(p=>({...record.inputs.find(i=>i.role==="source")!.material,start:p.start,end:p.end})):record.declaredCoverage;
      parts.push(...artifact.parts.slice(0,-1),{owner:"representation",kind:"record",proposal:{...record,form:method.request.method==="search"?"structured":"excerpt",declaredCoverage:coverage}});
      next={...next,candidates:[...next.candidates,artifact.candidate],resultIds:[...next.resultIds,artifact.candidate.id],storedBytes:next.storedBytes+artifact.bytes};
    }
    // Exact processing has no inferred semantic applicability. The manager still owes combination judgment.
    return {progress:{method:{...next,state:"ready"}},next:[],participants:parts};
  }
  private schedule(path:ActivityPathState,stage:ActivityStageState,method:RepresentationMethodProgress):Outcome {
    let queue=method.queue;
    if(!queue.length)queue=nextMethodFinalJobs(path.intent.id,method);
    if(!queue.length) {
      const gaps=methodCoverageGaps(method);
      if(gaps.length)return this.gap(method,stage,"representation_coverage_incomplete",gaps);
      return {progress:{method:{...method,state:"ready",current:null}},next:[]};
    }
    if(!this.hasStageRoom(path))return this.gap(method,stage,"representation_execution_budget_exhausted",{resources:path.resourceUse});
    const current=queue[0]!,key=methodJobKey(current);
    if(method.tried.includes(key))return this.gap(method,stage,"representation_conditions_already_tried",{job:current.id,key});
    if(method.modelCalls>=method.request.bounds.modelCalls&&!(method.request.reuseJudgments?.length))return this.gap(method,stage,"representation_model_budget_exhausted",{used:method.modelCalls});
    const next={...method,current,queue:queue.slice(1),tried:[...method.tried,key]};
    return {progress:{method:next},next:[this.nextStage(path,stage,"assemble",{method:next})]};
  }
  private gap(method:RepresentationMethodProgress,stage:ActivityStageState,code:string,details:unknown):Outcome {
    return {progress:{method:{...method,state:"gap",gap:{code,stageId:stage.request.id,details}}},next:[]};
  }
  private hasStageRoom(path:ActivityPathState):boolean {
    return path.resourceUse.admittedStages<path.intent.maximumStages&&path.resourceUse.dispatchedAttempts<path.intent.maximumAttempts&&Date.parse(this.ports.now())<Date.parse(path.intent.deadlineAt);
  }
  private state(path:ActivityPathState,stage:ActivityStageState):RepresentationMethodProgress {
    const state=(stage.request.input as {method?:RepresentationMethodProgress})?.method??(path.progress as {method?:RepresentationMethodProgress})?.method;
    if(state?.kind!=="representation_method_progress")throw new TypeError("representation_progress_unavailable");return state;
  }
  private nextStage(path:ActivityPathState,previous:ActivityStageState,kind:string,input:unknown):ActivityStageRequest {
    return {id:`${path.intent.id}:stage:${path.progressRevision+2}`,pathId:path.intent.id,stageKind:kind,input,
      capabilities:kind==="read"?["material-read"]:kind==="bind"?["material-read"]:[],dependencies:[{requestId:previous.request.id,condition:"accepted"}]};
  }
  private candidateSource(candidate:MethodCandidate,method:RepresentationMethodProgress):MethodSource {
    return {alias:candidate.id,role:"source",access:candidate.access,representation:candidate.representation,order:method.request.sources.length+method.candidates.indexOf(candidate),label:candidate.id,originalRole:"derived_representation",indivisibleGroup:candidate.id};
  }
  private inputSources(method:RepresentationMethodProgress,job:MethodJob):MethodSource[] {
    return [...methodSources(method).filter(s=>s.role==="background"||job.sources.includes(s.alias)||job.candidates.includes(s.alias)).map(s=>({...s,role:job.candidates.includes(s.alias)?"candidate" as const:s.role})),
      ...[...new Set([...job.sources,...job.candidates])].flatMap(id=>{const c=method.candidates.find(c=>c.id===id||c.segments.some(s=>s.id===id));if(!c)return [];const segment=c.segments.find(s=>s.id===id);return [{...this.candidateSource(c,method),alias:id,access:{...c.access,range:segment?.range??c.access.range},role:job.candidates.includes(id)?"candidate" as const:"source" as const}];})];
  }
  private expandedRequest(method:RepresentationMethodProgress,job:MethodJob) {
    return {...method.request,sources:this.inputSources(method,job)};
  }
  private async accessDescriptions(method:RepresentationMethodProgress):Promise<MaterialAccessDescription[]> {
    const result:MaterialAccessDescription[]=[];
    for(const source of [...method.request.sources,...method.candidates.map(c=>this.candidateSource(c,method))])result.push(await checkMethodAccess(this.ports.materials,source));
    for(const access of method.request.dependencyAccesses??[])result.push(await this.ports.materials.command({kind:"describe",holdId:access.holdId,recipient:access.recipient}) as MaterialAccessDescription);
    return result;
  }
}

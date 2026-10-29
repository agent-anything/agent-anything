import {ActivityPurposeRegistry,type ActivityPurposeBinding} from "../../activity/ActivityPurpose.js";
import type {ActivityPurposeHandler} from "../../activity/ActivityHandoffProcessor.js";
import type {ActivityPathIntent,ActivityPathState,ActivityHandoffItem} from "../../activity/ActivityHandoff.js";
import {REPRESENTATION_METHOD_PURPOSE,startRepresentationMethod,type RepresentationMethodRequest,type RepresentationMethodProgress} from "./RepresentationMethod.js";
import {RepresentationMethodPath,type RepresentationMethodDependencies} from "./RepresentationMethodPath.js";
import {contextInputAcceptance} from "../ContextInputAcceptance.js";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {RepresentationJudgment} from "@agent-anything/context/representation";
import type {MaterialAccessDescription,MaterialHold} from "@agent-anything/context/custody";
import type {SharedAcceptancePart} from "../../activity/SharedAcceptance.js";
import type {ContextUseControl} from "@agent-anything/context/selection";
import {quoteRepresentationMethod} from "./RepresentationMethodQuotation.js";

/** Explicit delegated entry; it does not decide when the product should compact. */
export class RepresentationMethodWork {
  readonly purpose:ActivityPurposeBinding;
  constructor(private readonly ports:RepresentationMethodDependencies,registry:ActivityPurposeRegistry<ActivityPurposeHandler>) {
    this.purpose=registry.register(REPRESENTATION_METHOD_PURPOSE,new RepresentationMethodPath(ports));
  }
  async submit(intent:Omit<ActivityPathIntent,"purpose"|"owner">,request:RepresentationMethodRequest):Promise<void> {
    const parts=this.prepareSubmission(intent,request);
    await this.ports.activities.command({kind:"open_path",intent:parts[0].proposal as ActivityPathIntent});
    await this.ports.activities.command({kind:"submit",request:parts[1].proposal as import("../../activity/ActivityHandoff.js").ActivityStageRequest});
  }
  /** The original decision, scheduling acceptance and initial handoff may be accepted together. */
  prepareSubmission(intent:Omit<ActivityPathIntent,"purpose"|"owner">,request:RepresentationMethodRequest):readonly [SharedAcceptancePart,SharedAcceptancePart] {
    const method=startRepresentationMethod(request);
    if(intent.runId!==request.recipient.runId)throw new TypeError("representation_method_run_mismatch");
    const quote=quoteRepresentationMethod(request);
    if(quote.gaps.length||intent.maximumStages<quote.minimum.stages||intent.maximumAttempts<quote.minimum.attempts)throw new TypeError("representation_known_work_exceeds_delegation");
    const source=request.sources[0]!;
    const resourceLimits={readBytes:request.bounds.readBytes,storedBytes:request.bounds.storedBytes,modelCalls:request.bounds.modelCalls,measurementCalls:request.capacity.maximumMeasurements};
    if(intent.resourceLimits&&modelInputValueDigest(intent.resourceLimits)!==modelInputValueDigest(resourceLimits))throw new TypeError("representation_resource_binding_invalid");
    return [{owner:"activity",kind:"path_opening",proposal:{...intent,resourceLimits,owner:this.purpose.contract.acceptanceOwner,purpose:this.purpose}},
      {owner:"activity",kind:"stage_submission",proposal:{id:`${intent.id}:stage:1`,pathId:intent.id,stageKind:request.method==="preserve"?"exact":"read",input:{method,quotation:quote,source:source.alias,offset:source.access.range.start},capabilities:["material-read"],dependencies:[]}}];
  }
  async result(pathId:string):Promise<{kind:"pending"}|{kind:"cancelled"}|{kind:"ready"|"gap";progress:RepresentationMethodProgress}> {
    const path=await this.path(pathId);
    if(path.cancelled)return {kind:"cancelled"};
    const progress=(path.progress as {method?:RepresentationMethodProgress})?.method;
    if(progress?.state==="ready"||progress?.state==="gap")return {kind:progress.state,progress};
    return {kind:"pending"};
  }
  /** The method reports its own unfinished duties and retained outcomes; CRM need not inspect its queue. */
  async describe(pathId:string):Promise<{
    state:"accepted"|"active"|"ready"|"failed"|"cancelled"|"unknown";
    revision:number;quotation:ReturnType<typeof quoteRepresentationMethod>;
    confirmed:{candidates:readonly string[];assessments:readonly string[]};
    remainingJobs:readonly {id:string;kind:string}[];
    used:{stages:number;attempts:number;readBytes:number;storedBytes:number;modelCalls:number};
    remaining:{stages:number;attempts:number;readBytes:number;storedBytes:number;modelCalls:number};
    limitations:readonly string[];
    allowance:import("../../activity/ActivityHandoff.js").ActivityResourceAllowance;
  }> {
    const path=await this.path(pathId),first=await this.ports.activities.command({kind:"read_stage",requestId:`${pathId}:stage:1`}) as import("../../activity/ActivityHandoff.js").ActivityStageState|null;
    const method=(path.progress as {method?:RepresentationMethodProgress})?.method??(first?.request.input as {method?:RepresentationMethodProgress}|undefined)?.method;
    if(!method)throw new TypeError("representation_progress_unavailable");
    let unknown=false;
    for(let after=0;;) {
      const page=await this.ports.activities.command({kind:"pending",runId:path.intent.runId,pathId,after,limit:256}) as readonly ActivityHandoffItem[];
      for(const item of page.filter(item=>item.pathId===pathId)) {
        const stage=await this.ports.activities.command({kind:"read_stage",requestId:item.requestId}) as import("../../activity/ActivityHandoff.js").ActivityStageState;
        if(stage.result?.outcome==="unknown"||path.cancelled&&item.kind==="reconciliation")unknown=true;
      }
      if(page.length<256)break;after=page.at(-1)!.sequence;
    }
    const used={stages:path.resourceUse.admittedStages,attempts:path.resourceUse.dispatchedAttempts,readBytes:method.readBytes,storedBytes:method.storedBytes,modelCalls:method.modelCalls};
    const limits={stages:path.intent.maximumStages,attempts:path.intent.maximumAttempts,...method.request.bounds};
    const allowance=await this.ports.activities.command({kind:"resource_allowance",pathId}) as import("../../activity/ActivityHandoff.js").ActivityResourceAllowance;
    return {allowance,state:unknown?"unknown":path.cancelled?"cancelled":method.state==="gap"?"failed":method.state==="ready"?"ready":path.progressRevision?"active":"accepted",
      revision:path.progressRevision,quotation:quoteRepresentationMethod(method.request),confirmed:{candidates:method.resultIds,assessments:method.assessments.map(a=>a.rawResultId)},
      remainingJobs:[...(method.current?[method.current]:[]),...method.queue].map(j=>({id:j.id,kind:j.kind})),used,
      remaining:{stages:limits.stages-used.stages,attempts:limits.attempts-used.attempts,
        readBytes:allowance.limits.readBytes!-(allowance.reserved.readBytes??0),
        storedBytes:allowance.limits.storedBytes!-(allowance.reserved.storedBytes??0),
        modelCalls:allowance.limits.modelCalls!-(allowance.reserved.modelCalls??0)},
      limitations:method.state==="working"?["Remaining listed jobs are not a complete cost forecast; future split, check, repair and recipient adoption duties remain conditional"]:method.gap?[method.gap.code]:[]};
  }
  async cancel(pathId:string):Promise<void> {
    const path=await this.path(pathId);
    await this.ports.activities.command({kind:"cancel",pathId,expectedControlRevision:path.controlRevision});
  }
  /** CRM establishes that the original producer has no remaining consumers; retained evidence is not disposed here. */
  async prepareClosure(pathId:string,basis:string):Promise<readonly SharedAcceptancePart[]> {
    if(!basis)throw new TypeError("representation_closure_basis_missing");
    const path=await this.path(pathId),parts:SharedAcceptancePart[]=[];
    if(!path.cancelled)parts.push({owner:"activity",kind:"path_cancellation",proposal:{kind:"cancel",pathId,expectedControlRevision:path.controlRevision}});
    if(path.intent.scheduledWorkId) {
      const work=await this.ports.activities.command({kind:"read_schedule",workId:path.intent.scheduledWorkId}) as import("../../activity/ActivityScheduling.js").ActivitySchedulingAcceptance|null;
      if(!work)throw new TypeError("representation_schedule_missing");
      if(!work.closed)parts.push({owner:"activity",kind:"scheduling_closure",proposal:{kind:"close_scheduled_work",workId:work.intent.workId,expectedRevision:work.revision,basis}});
    }
    return parts;
  }
  /** The manager presents the exact checked combination; existing participants still accept it together. */
  async prepareAdoption(pathId:string,input:Omit<Parameters<typeof contextInputAcceptance>[0],"judgment">):Promise<ReturnType<typeof contextInputAcceptance>> {
    const result=await this.result(pathId);
    if(result.kind!=="ready"||result.progress.request.method!=="check_combination"||result.progress.request.combinationDigest!==modelInputValueDigest(input.prepared)||modelInputValueDigest(result.progress.request.combination?.scope)!==modelInputValueDigest(input.scope))throw new TypeError("representation_adoption_basis_invalid");
    const assessment=result.progress.assessments.at(-1);
    if(!assessment?.supported||assessment.scope!=="both")throw new TypeError("representation_adoption_unconfirmed");
    const judgment=await this.ports.representations.command({kind:"read_judgment",id:assessment.judgmentIds[0]!}) as RepresentationJudgment|null;
    if(!judgment)throw new TypeError("representation_adoption_judgment_missing");
    return contextInputAcceptance({...input,judgment});
  }
  /** Protection transfer participates in the same acceptance as the new owner's responsibility. */
  async prepareResultRetention(pathId:string,acquire:readonly MaterialHold[],disposeIds:readonly string[],basis:string):Promise<SharedAcceptancePart> {
    const path=await this.path(pathId),progress=(path.progress as {method?:RepresentationMethodProgress})?.method;
    if(!progress||!path.cancelled&&progress.state!=="ready"&&progress.state!=="gap")throw new TypeError("representation_result_unsettled");
    await this.requireSettled(path);
    const releases:string[]=[];
    for(const id of disposeIds) {
      const candidate=progress.candidates.find(c=>c.id===id);if(!candidate)throw new TypeError("representation_result_unknown");
      const description=await this.ports.materials.command({kind:"describe",holdId:candidate.access.holdId,recipient:candidate.access.recipient}) as MaterialAccessDescription;
      if(description.hold.basis!==pathId||description.hold.responsibility!=="checkpoint")throw new TypeError("representation_retention_not_owned");
      releases.push(description.hold.id);
    }
    return {owner:"material_custody",kind:"holds",proposal:{acquire,release:[...new Set(releases)],basis}};
  }
  /** Releases only this method's auxiliary input responsibilities, never Parent delivery or adopted output holds. */
  async releaseInputs(pathId:string):Promise<void> {
    const path=await this.path(pathId),progress=(path.progress as {method?:RepresentationMethodProgress})?.method;
    if(!progress)throw new TypeError("representation_progress_unavailable");
    await this.requireSettled(path);
    for(const input of progress.acceptedInputs) {
      await this.ports.selections.command({kind:"retire_input",inputId:input.inputId,basis:`${pathId}:release-inputs`});
      const current=await this.ports.selections.command({kind:"current",scopeId:input.scopeId});
      if(current) {
        const control=await this.ports.selections.command({kind:"current_control",scopeId:input.scopeId}) as ContextUseControl;
        await this.ports.selections.command({kind:"withdraw",scopeId:input.scopeId,expectedSelectionId:input.selectionId,expectedControlRevision:control.revision,basis:`${pathId}:release-inputs`});
      }
      for(const holdId of input.holds)await this.ports.materials.command({kind:"release",holdId,basis:`${pathId}:release-inputs`});
    }
  }
  private async requireSettled(path:ActivityPathState):Promise<void> {
    for(let after=0;;) {
      const pending=await this.ports.activities.command({kind:"pending",runId:path.intent.runId,pathId:path.intent.id,after,limit:256}) as readonly ActivityHandoffItem[];
      if(pending.some(item=>item.pathId===path.intent.id))throw new TypeError("representation_responsibility_unsettled");
      if(pending.length<256)return;after=pending.at(-1)!.sequence;
    }
  }
  private async path(pathId:string):Promise<ActivityPathState> {
    const path=await this.ports.activities.command({kind:"read_path",pathId}) as ActivityPathState|null;
    if(!path||path.intent.purpose.digest!==this.purpose.digest)throw new TypeError("representation_method_binding_unavailable");return path;
  }
}

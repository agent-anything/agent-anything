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

/** Explicit delegated entry; it does not decide when the product should compact. */
export class RepresentationMethodWork {
  readonly purpose:ActivityPurposeBinding;
  constructor(private readonly ports:RepresentationMethodDependencies,registry:ActivityPurposeRegistry<ActivityPurposeHandler>) {
    this.purpose=registry.register(REPRESENTATION_METHOD_PURPOSE,new RepresentationMethodPath(ports));
  }
  async submit(intent:Omit<ActivityPathIntent,"purpose"|"owner">,request:RepresentationMethodRequest):Promise<void> {
    const method=startRepresentationMethod(request);
    if(intent.runId!==request.recipient.runId)throw new TypeError("representation_method_run_mismatch");
    const minimumReads=request.method==="preserve"?0:request.sources.reduce((sum,s)=>sum+Math.max(1,Math.ceil((s.access.range.end-s.access.range.start)/request.bounds.pageBytes)),0);
    const modelMethod=["summarize","restore","detail","check","check_combination"].includes(request.method);
    // Each model job needs assembly, fixed/full input organization, binding and dispatch.
    const minimumStages=minimumReads+(modelMethod?(["check","check_combination"].includes(request.method)?5:10):1)+(modelMethod&&request.sources.some(s=>s.division)?1:0);
    if(intent.maximumStages<minimumStages||intent.maximumAttempts<minimumStages||modelMethod&&request.bounds.modelCalls<2&&!["check","check_combination"].includes(request.method))throw new TypeError("representation_known_work_exceeds_delegation");
    await this.ports.activities.command({kind:"open_path",intent:{...intent,owner:this.purpose.contract.acceptanceOwner,purpose:this.purpose}});
    const source=request.sources[0]!;
    await this.ports.activities.command({kind:"submit",request:{id:`${intent.id}:stage:1`,pathId:intent.id,stageKind:request.method==="preserve"?"exact":"read",input:{method,source:source.alias,offset:source.access.range.start},capabilities:["material-read"],dependencies:[]}});
  }
  async result(pathId:string):Promise<{kind:"pending"}|{kind:"cancelled"}|{kind:"ready"|"gap";progress:RepresentationMethodProgress}> {
    const path=await this.path(pathId);
    if(path.cancelled)return {kind:"cancelled"};
    const progress=(path.progress as {method?:RepresentationMethodProgress})?.method;
    if(progress?.state==="ready"||progress?.state==="gap")return {kind:progress.state,progress};
    return {kind:"pending"};
  }
  async cancel(pathId:string):Promise<void> {
    const path=await this.path(pathId);
    await this.ports.activities.command({kind:"cancel",pathId,expectedControlRevision:path.controlRevision});
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
      const pending=await this.ports.activities.command({kind:"pending",runId:path.intent.runId,after,limit:256}) as readonly ActivityHandoffItem[];
      if(pending.some(item=>item.pathId===path.intent.id))throw new TypeError("representation_responsibility_unsettled");
      if(pending.length<256)return;after=pending.at(-1)!.sequence;
    }
  }
  private async path(pathId:string):Promise<ActivityPathState> {
    const path=await this.ports.activities.command({kind:"read_path",pathId}) as ActivityPathState|null;
    if(!path||path.intent.purpose.digest!==this.purpose.digest)throw new TypeError("representation_method_binding_unavailable");return path;
  }
}

import {modelInputValueDigest,type ModelInputSourceRef} from "@agent-anything/model-interaction/input";
import type {MaterialCustodyPort,MaterialAccessAdmission} from "@agent-anything/context/custody";
import type {RepresentationCatalogPort} from "@agent-anything/context/representation";
import type {ContextUseScope} from "@agent-anything/context/selection";
import {activityFactSourceId,type ActivityHandoffPort,type ActivityPathIntent,type ActivityPathState,type ActivityStageState,type ActivityStageRequest,type SharedAcceptancePart} from "../activity/index.js";
import {ContextInputMaterializationWork,type ContextInputMaterializationRequest,type RetainedInputText} from "./ContextInputMaterialization.js";
import {readContextInputEvidence} from "./ContextInputEvidence.js";
import type {ContextCurrentInput} from "./ContextPreparationPolicy.js";
import {readPreparedInputRejection} from "./PreparedInputRejection.js";
import type {PreparedContextInput} from "./ContextInputPreparation.js";
import type {RepresentationMethodWork} from "./methods/RepresentationMethodWork.js";
import type {MethodCandidate,RepresentationMethodRequest,RepresentationMethodProgress} from "./methods/RepresentationMethod.js";
import {methodCombinationEvidence} from "./methods/MethodCombinationEvidence.js";
import type {InputSupplyBinding} from "./InputSupplyResponsibility.js";
import type {ActivityReconsiderationState} from "../activity/index.js";
import {sameMethodInputSchedulingBinding,validateMethodInputScheduling} from "./ContextMethodInputScheduling.js";

export interface ContextMethodInputPlan {
  readonly revision:"5";
  readonly scheduling:import("../activity/index.js").ActivitySchedulingIntent|null;
  readonly inputSupply?:InputSupplyBinding;
  readonly producers:readonly {readonly pathId:string;readonly candidateIds:readonly string[]}[];
  readonly scope:ContextUseScope;
  readonly materialAdmissions?:readonly MaterialAccessAdmission[];
  readonly materialization:{readonly intent:Omit<ActivityPathIntent,"purpose"|"owner">;readonly request:ContextInputMaterializationRequest};
  readonly check:{readonly intent:Omit<ActivityPathIntent,"purpose"|"owner">;readonly objective:string;
    readonly template:RepresentationMethodRequest["template"];
    readonly sourceBasis?:"original"|"qualified_when_covered";
    readonly capacity:RepresentationMethodRequest["capacity"];readonly bounds:RepresentationMethodRequest["bounds"]};
}
export type ContextMethodInputSupplyResult=(
  | {readonly kind:"waiting";readonly observeSources:readonly string[];readonly participants:readonly SharedAcceptancePart[]}
  | {readonly kind:"unavailable";readonly stage:"producer"|"materialization"|"organization"|"check";readonly reason:string;readonly observeSources:readonly string[];
      readonly inputGap?:Extract<ContextCurrentInput,{kind:"gap"}>;
      readonly providerRejection?:NonNullable<Awaited<ReturnType<typeof readPreparedInputRejection>>>}
  | {readonly kind:"checked";readonly prepared:PreparedContextInput;readonly checkPathId:string;readonly progress:RepresentationMethodProgress;readonly observeSources:readonly string[]})&
  {readonly conditions:readonly SharedAcceptancePart[]};

/** Consumes a retained method result for one recipient. CRM still owns selection and adoption. */
export class ContextMethodInputSupply {
  /** Validate the original recipient duty; this does not assess method semantics or grant authority. */
  static validateInputSupply(binding:InputSupplyBinding,path:ActivityPathIntent,first:ActivityStageState,
    state:ActivityReconsiderationState|null,initial:boolean,scheduling:import("../activity/index.js").ActivitySchedulingAcceptance|null):void {
    const input=first.request.input as {methodInputPlan?:ContextMethodInputPlan;request?:unknown},plan=input.methodInputPlan;
    const {purpose:_,owner:__,...intent}=path,equal=(a:unknown,b:unknown)=>modelInputValueDigest(a)===modelInputValueDigest(b);
    if(!plan||plan.revision!=="5"||!equal(plan.inputSupply??null,binding)||!equal(plan.materialization.intent,intent)||
      first.request.pathId!==path.id||!equal(plan.materialization.request,input.request)||plan.scope.runId!==binding.runId||plan.scope.owner!==binding.owner||
      !state||state.subscription.owner!==binding.owner||state.subscription.runId!==binding.runId||state.subscription.binding?.kind!=="activity_path"||state.subscription.binding.id!==path.id)
      throw new TypeError("method_input_supply_binding_unconfirmed");
    validateMethodInputScheduling(plan);
    if(plan.scheduling&&(!scheduling||initial&&scheduling.closed||!sameMethodInputSchedulingBinding(plan.scheduling,scheduling.intent)))
      throw new TypeError("method_input_supply_scheduling_unconfirmed");
    const original=ContextInputMaterializationWork.initialStage(path.id,plan.materialization.request);
    if(!equal(first.request,{...original,input:{...original.input as object,methodInputPlan:plan}})||
      (initial&&state.closed)||![...plan.producers.map(p=>p.pathId),path.id].every(id=>["control","progress"].every(kind=>
        state.subscription.sources.includes(activityFactSourceId(kind as "control"|"progress",id)))))
      throw new TypeError("method_input_supply_binding_unconfirmed");
  }
  constructor(private readonly ports:{
    readonly activities:ActivityHandoffPort;
    readonly materials:MaterialCustodyPort;
    readonly representations:RepresentationCatalogPort;
    readonly materialization:Pick<ContextInputMaterializationWork,"prepareSubmission"|"result">;
    readonly methods:Pick<RepresentationMethodWork,"result"|"prepareSubmission">;
  }) {}

  async readPlan(materializationPathId:string):Promise<ContextMethodInputPlan|null> {
    const first=await this.ports.activities.command({kind:"read_stage",requestId:`${materializationPathId}:stage:1`}) as ActivityStageState|null;
    if(!first)return null;
    const input=first.request.input as {methodInputPlan?:ContextMethodInputPlan};
    if(!input.methodInputPlan||input.methodInputPlan.materialization.intent.id!==materializationPathId)throw new TypeError("method_input_original_plan_missing");
    if(input.methodInputPlan.revision!=="5")throw new TypeError("method_input_plan_revision_unavailable");
    validateMethodInputScheduling(input.methodInputPlan);
    if(!await this.existing(materializationPathId,this.materializationParts(input.methodInputPlan)))throw new TypeError("method_input_original_path_missing");
    return input.methodInputPlan;
  }

  async prepare(plan:ContextMethodInputPlan,signal:AbortSignal):Promise<ContextMethodInputSupplyResult> {
    signal.throwIfAborted();
    if(plan.revision!=="5")throw new TypeError("method_input_plan_revision_unavailable");
    validateMethodInputScheduling(plan);
    const {scope,materialization,check}=plan,demand=materialization.request.demand;
    if(check.sourceBasis!==undefined&&!["original","qualified_when_covered"].includes(check.sourceBasis))throw new TypeError("method_input_check_basis_unknown");
    const paths=[...plan.producers.map(p=>p.pathId),materialization.intent.id,materialization.request.preparationIntent.id,check.intent.id];
    if(new Set(paths).size!==paths.length||
      scope.runId!==demand.runId||scope.recipient!==demand.recipient||scope.purpose!==demand.purpose||scope.target!==demand.targetRevision||
      materialization.intent.runId!==scope.runId||check.intent.runId!==scope.runId||scope.authorityBasis!==materialization.intent.permissionBasis||
      check.intent.permissionBasis!==materialization.intent.permissionBasis)throw new TypeError("method_input_plan_scope_invalid");
    const observed:string[]=[],conditions:SharedAcceptancePart[]=[];
    const observe=(id:string)=>observed.push(activityFactSourceId("progress",id),activityFactSourceId("control",id));
    const waiting=(participants:readonly SharedAcceptancePart[]=[]):ContextMethodInputSupplyResult=>({kind:"waiting",observeSources:[...new Set(observed)],participants,conditions});
    const unavailable=(stage:"producer"|"materialization"|"organization"|"check",reason:string):Extract<ContextMethodInputSupplyResult,{kind:"unavailable"}>=>({kind:"unavailable",stage,reason,observeSources:[...new Set(observed)],conditions});
    plan.producers.forEach(p=>observe(p.pathId));
    const producers:{pathId:string;method:RepresentationMethodProgress;candidates:readonly MethodCandidate[]}[]=[];
    for(const original of plan.producers) {
      signal.throwIfAborted();
      const producer=await this.ports.activities.command({kind:"read_path",pathId:original.pathId}) as ActivityPathState|null;
      if(!producer||producer.intent.runId!==scope.runId||producer.intent.owner!==scope.owner||producer.intent.permissionBasis!==scope.authorityBasis)
        throw new TypeError("method_input_original_producer_unavailable");
      conditions.push({owner:"activity",kind:"path_condition",proposal:{pathId:original.pathId,
        expected:{controlRevision:producer.controlRevision,progressRevision:producer.progressRevision,cancelled:producer.cancelled},requireSettled:false}});
      const produced=await this.ports.methods.result(original.pathId);signal.throwIfAborted();
      if(producer.cancelled||produced.kind==="cancelled")return unavailable("producer","cancelled");
      if(produced.kind==="pending")return waiting();
      if(produced.kind==="gap")return unavailable("producer",produced.progress.gap?.code??"method_gap");
      const method=produced.progress;
      if(method.request.targetRevision!==scope.target)throw new TypeError("method_input_target_changed");
      producers.push({pathId:original.pathId,method,candidates:original.candidateIds.map(id=>{
        const value=method.candidates.find(c=>c.id===id);
        if(!value||!method.resultIds.includes(id))throw new TypeError("method_input_unconfirmed_candidate");return value;
      })});
    }
    const candidates=producers.flatMap(p=>p.candidates);
    if(new Set(candidates.map(c=>modelInputValueDigest(c.representation))).size!==candidates.length)
      throw new TypeError("method_input_duplicate_candidate");
    const declarations=demand.contributions.flatMap(c=>c.options.flatMap(o=>o.sections.flatMap<{content:Omit<RetainedInputText,"kind">;representation:ModelInputSourceRef}>(s=>{
      const content=s.section.content;
      if(content.kind==="retained_text") {
        const bindings=o.dataTextBindings?.filter(b=>b.sectionId===s.section.id)??[];
        if(bindings.length>1)throw new TypeError("method_input_data_binding_invalid");
        return [{content,representation:bindings[0]?.representation??s.section.source}];
      }
      if(content.kind!=="retained_result_text")return [];
      if(!Array.isArray(content.replacements)||!content.replacements.length)throw new TypeError("method_input_result_slot_binding_missing");
      return content.replacements.map(part=>{
        const bindings=o.resultTextBindings?.filter(b=>b.sectionId===s.section.id&&modelInputValueDigest(b.slot)===modelInputValueDigest(part.slot));
        if(bindings?.length!==1)throw new TypeError("method_input_result_slot_binding_missing");
        return {content:part,representation:bindings[0]!.representation};
      });
    })));
    for(const candidate of candidates)if(!declarations.some(({content,representation})=>
      modelInputValueDigest(content.access.range)===modelInputValueDigest(candidate.access.range)&&
      representation.owner==="context-representation"&&representation.kind==="representation"&&
      representation.id===candidate.representation.id&&representation.revision===candidate.representation.revision))throw new TypeError("method_input_candidate_declaration_missing");
    const materialParts=this.materializationParts(plan);
    for(const admission of plan.materialAdmissions??[]) {
      const {source,grant,hold}=admission;
      const equal=(a:unknown,b:unknown)=>modelInputValueDigest(a)===modelInputValueDigest(b);
      const recipient={runId:scope.runId,recipient:scope.recipient,purpose:scope.purpose};
      if(!candidates.some(c=>equal(c.access,source))||!equal(grant.recipient,recipient)||!equal(hold.consumer,recipient)||
        grant.basis!==scope.authorityBasis||hold.basis!==materialization.intent.id||hold.responsibility!=="preparation"||
        !equal(grant.range,source.range)||!equal(hold.range,source.range)||
        !declarations.some(s=>s.content.access.holdId===hold.id&&
          equal(s.content.access.range,hold.range)&&equal(s.content.access.recipient,recipient)))
        throw new TypeError("method_input_material_admission_mismatch");
    }
    const existing=await this.existing(materialization.intent.id,materialParts);
    observe(materialization.intent.id);
    if(!existing)return waiting([...(plan.materialAdmissions??[]).map(proposal=>({owner:"material_custody",kind:"admit_access",proposal})),...materialParts]);
    const materialized=await this.ports.materialization.result(materialization.intent.id);signal.throwIfAborted();
    if(materialized.kind==="pending"||materialized.kind==="changed")return waiting();
    if(materialized.kind==="cancelled")return unavailable("materialization","cancelled");
    if(materialized.kind==="gap")return unavailable("materialization",materialized.reason);
    if(materialized.kind!=="organized")throw new TypeError("method_input_materialization_state_invalid");
    if(materialized.preparationPathId!==materialization.request.preparationIntent.id)throw new TypeError("method_input_organization_changed");
    observe(materialized.preparationPathId);
    const organized=await readContextInputEvidence({activities:this.ports.activities,pathId:materialized.preparationPathId,scope,demandId:demand.id,boundary:demand.historyBoundary},signal);
    if(organized.kind==="pending"||organized.kind==="changed")return waiting();
    if(organized.kind==="cancelled")return unavailable("organization","cancelled");
    if(organized.kind==="unassessed")return unavailable("organization",organized.reason);
    if(organized.kind!=="available")throw new TypeError("method_input_organization_state_invalid");
    if(organized.current.kind==="gap")return {...unavailable("organization",organized.current.gap.reason),inputGap:organized.current};
    const prepared=organized.current.prepared;
    const providerRejection=await readPreparedInputRejection(this.ports.activities,plan.inputSupply,prepared);
    signal.throwIfAborted();
    if(providerRejection)return {...unavailable("organization","provider_input_previously_rejected"),providerRejection};
    const {inheritedChecks,producerEvidence,...evidence}=await methodCombinationEvidence({producers,qualified:check.sourceBasis==="qualified_when_covered",
      activities:this.ports.activities,materials:this.ports.materials,representations:this.ports.representations,signal});
    const request:RepresentationMethodRequest={kind:"representation_method",methodRevision:"1",method:"check_combination",objective:check.objective,
      recipient:{runId:scope.runId,recipient:scope.owner,purpose:check.template.purpose},targetRevision:scope.target,template:check.template,
      capacity:check.capacity,bounds:check.bounds,...evidence,combine:"keep",omission:null,search:null,combinationDigest:modelInputValueDigest(prepared),
      combination:{prepared,scope,subjects:candidates.map(c=>c.representation),producers:producerEvidence,...(inheritedChecks.length?{inheritedChecks}:{})}};
    const checkParts=this.ports.methods.prepareSubmission(check.intent,request);
    const checking=await this.existing(check.intent.id,checkParts);observe(check.intent.id);
    if(!checking)return waiting(checkParts);
    const checked=await this.ports.methods.result(check.intent.id);signal.throwIfAborted();
    if(checked.kind==="pending")return waiting();
    if(checked.kind==="cancelled")return unavailable("check","cancelled");
    if(checked.kind==="gap")return unavailable("check",checked.progress.gap?.code??"combination_gap");
    const assessment=checked.progress.assessments.at(-1);
    if(modelInputValueDigest(checked.progress.request)!==modelInputValueDigest(request)||!assessment?.supported||assessment.scope!=="both")
      throw new TypeError("method_input_combination_not_supported");
    return {kind:"checked",prepared,checkPathId:check.intent.id,progress:checked.progress,observeSources:[...new Set(observed)],conditions};
  }
  private materializationParts(plan:ContextMethodInputPlan):readonly SharedAcceptancePart[] {
    const parts=[...this.ports.materialization.prepareSubmission(plan.materialization.intent,plan.materialization.request)];
    const first=parts[1]!.proposal as ActivityStageRequest;
    // The supplier retains its continuation with the first delegated input. The reader only interprets request/pages.
    parts[1]={...parts[1]!,proposal:{...first,input:{...first.input as object,methodInputPlan:plan}}};
    return parts;
  }
  private async existing(pathId:string,parts:readonly SharedAcceptancePart[]):Promise<boolean> {
    const path=await this.ports.activities.command({kind:"read_path",pathId}) as ActivityPathState|null;
    if(!path)return false;
    const original=await this.ports.activities.command({kind:"read_stage",requestId:`${pathId}:stage:1`}) as ActivityStageState|null;
    if(modelInputValueDigest(path.intent)!==modelInputValueDigest(parts[0]!.proposal)||
      !original||modelInputValueDigest(original.request)!==modelInputValueDigest(parts[1]!.proposal))throw new TypeError("method_input_original_binding_changed");
    return true;
  }
}

import type Database from "better-sqlite3";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {MaterialCustodyError,custodyToken,containsMaterialRange,type MaterialHold,type MaterialRange,type MaterialRecipient} from "@agent-anything/context/custody";
import type {ContextAcceptancePart,ContextDelivery,ContextDeliveryPage,ContextInputBinding,ContextSelectionCommand,ContextSelectionProposal,
  ContextSelectionSnapshot,ContextSelectionValue,ContextUseControl,ContextUseScope,ContextDeliveryState,ContextDeliveryFinalization} from "@agent-anything/context/selection";
import type {RepresentationRef} from "@agent-anything/context/representation";
import {contextProcessObject as object,contextProcessRelationship as relation,type ContextProcessRelationship} from "@agent-anything/context/evidence";
import {activityFactSourceId,type SharedAcceptanceProposal,type ActivityReconsiderationReceipt} from "@agent-anything/agent-runtime/activity";
import {validatePreparedContextInput,sourceMaterialOutcome,contextDeliveryFactSource,type SourceMaterialPublicationRequest,type PreparedContextInput,
  type ContextDeliveryFactPublisher,type ContextDeliveryTransition,type ContextDeliveryLifecycleReader} from "@agent-anything/agent-runtime/context-representation";
import type {ExecutionContentRoot} from "./ExecutionContent.js";
import {SharedAcceptanceRejection,type SharedAcceptanceParticipant} from "./SharedAcceptanceDatabase.js";
import {ContextFoundationRecords,checkedJson,requireSame} from "./ContextFoundationRecords.js";
import {MaterialCustodyDatabase} from "./MaterialCustodyDatabase.js";
import {RepresentationDatabase} from "./RepresentationDatabase.js";

export const CONTEXT_SELECTION_SCHEMA=`
CREATE TABLE context_use_scopes(id TEXT PRIMARY KEY,scope_key TEXT NOT NULL UNIQUE,run_id TEXT NOT NULL,value TEXT NOT NULL,digest TEXT NOT NULL,control TEXT NOT NULL,control_digest TEXT NOT NULL,current_id TEXT);
CREATE TABLE context_selection_versions(id TEXT PRIMARY KEY,scope_id TEXT NOT NULL,acceptance_id TEXT NOT NULL,value TEXT NOT NULL,digest TEXT NOT NULL);
CREATE TABLE context_input_bindings(id TEXT PRIMARY KEY,scope_id TEXT NOT NULL,acceptance_id TEXT NOT NULL,value TEXT NOT NULL,digest TEXT NOT NULL,retired TEXT);
CREATE TABLE context_recipient_deliveries(id TEXT PRIMARY KEY,recipient_key TEXT NOT NULL,value TEXT NOT NULL,digest TEXT NOT NULL,input_id TEXT,accepted_response TEXT,disposition TEXT);
CREATE INDEX context_recipient_delivery_lookup ON context_recipient_deliveries(recipient_key);
CREATE TABLE context_input_sends(input_id TEXT NOT NULL,attempt_id TEXT NOT NULL,PRIMARY KEY(input_id,attempt_id));
`;
type Selection=NonNullable<ContextSelectionProposal["selection"]>;
type DeliveryPart=Extract<ContextAcceptancePart,{owner:"context_delivery"}>;
interface StoredInput extends Omit<ContextInputBinding,"exactInput"> {readonly exactInputRoot:ExecutionContentRoot;readonly exactInputDigest:string;}
export class ContextSelectionDatabase {
  constructor(private readonly db:Database.Database,private readonly records:ContextFoundationRecords,
    private readonly materials:MaterialCustodyDatabase,private readonly representations:RepresentationDatabase,
    private readonly retain:(value:unknown)=>ExecutionContentRoot,private readonly hydrate:(root:ExecutionContentRoot)=>unknown,
    private readonly confirmResult:(runId:string,pathId:string,inputDigest:string,resultId:string)=>boolean,
    private readonly confirmAttempt:(runId:string,pathId:string,requestId:string,inputDigest:string,attemptId:string)=>boolean,
    private readonly pathSettled:(pathId:string)=>boolean,
    private readonly confirmPreparation:(runId:string,input:PreparedContextInput)=>boolean,
    private readonly consumer:(pathId:string)=>import("@agent-anything/agent-runtime/activity").ActivityPathState|null,
    private readonly deliveryFacts:ContextDeliveryFactPublisher,
    private readonly deliveryLifetime:ContextDeliveryLifecycleReader) {}
  command(command:ContextSelectionCommand):ContextSelectionValue {
    switch(command.kind) {
      case "lookup_scope":{
        custodyToken(command.scopeId);
        if(!this.db.prepare("SELECT id FROM context_use_scopes WHERE id=?").get(command.scopeId))return null;
        const current=this.scope(command.scopeId);
        return {scope:current.scope,control:current.control,selection:current.currentId?this.selection(current.currentId):null};
      }
      case "scope":return this.registerScope(command.scope);
      case "control":return this.control(command.control,command.expectedRevision);
      case "current":{const scope=this.scope(command.scopeId);return scope.currentId?this.selection(scope.currentId):null;}
      case "current_control":return this.scope(command.scopeId).control;
      case "binding":return this.binding(command.inputId,command.checkCurrentControl);
      case "delivery":return this.delivery(command.id);
      case "delivery_state":return this.deliveryState(command.id);
      case "pending_deliveries":return this.pendingDeliveries(command);
      case "sent":return this.sent(command.inputId,command.attemptId);
      case "retire_input":return this.retireInput(command.inputId,command.basis);
      case "withdraw":return this.withdraw(command);
    }
  }
  registeredScope(id:string):{scope:ContextUseScope;control:ContextUseControl} {return this.scope(id);}
  participants():readonly SharedAcceptanceParticipant[] {
    return [
      {owner:"context_selection",kinds:["scope","selection_input","input_retirement"],prepare:(part,acceptance)=>{
        if(part.kind==="input_retirement") {
          const release=part.proposal as import("@agent-anything/context/selection").ContextInputRetirement;
          custodyToken(release.basis);
          if(!Array.isArray(release.inputIds)||!Array.isArray(release.withdrawals)||
            new Set(release.inputIds).size!==release.inputIds.length||new Set(release.withdrawals.map(w=>w.scopeId)).size!==release.withdrawals.length)
            reject("input_retirement_invalid");
          for(const id of new Set([...release.inputIds.map(id=>this.storedInput(id).input.scopeId),...release.withdrawals.map(w=>w.scopeId)])) {
            const scope=this.scope(id).scope;
            if(scope.runId!==acceptance.scope||scope.owner!==acceptance.actor)reject("selection_release_actor_invalid");
          }
          return {release:structuredClone(release)};
        }
        if(part.kind==="scope") {
          const scope=part.proposal as ContextUseScope;
          if(scope.runId!==acceptance.scope||scope.owner!==acceptance.actor)reject("scope_actor_invalid");
          return {scope:structuredClone(scope)};
        }
        const proposal=part.proposal as ContextSelectionProposal;
        const scope=(acceptance.parts.find(part=>part.owner==="context_selection"&&part.kind==="scope"&&
          (part.proposal as ContextUseScope).id===proposal.scopeId)?.proposal as ContextUseScope|undefined)??this.scope(proposal.scopeId).scope;
        if(acceptance.id!==proposal.id || acceptance.scope!==scope.runId || acceptance.actor!==scope.owner)reject("selection_actor_invalid");
        const {exactInput,...metadata}=proposal.input;
        if(exactInput && typeof exactInput==="object" && "kind" in exactInput && exactInput.kind==="prepared_context_input") {
          const prepared=exactInput as PreparedContextInput;
          validatePreparedContextInput(prepared);
          if(prepared.demand.runId!==scope.runId || prepared.demand.recipient!==scope.recipient || prepared.demand.purpose!==scope.purpose ||
            prepared.demand.targetRevision!==scope.target || !this.confirmPreparation(scope.runId,prepared))reject("input_preparation_unconfirmed");
          if(modelInputValueDigest(prepared.deliveries)!==modelInputValueDigest(proposal.input.deliveries))reject("input_prepared_delivery_mismatch");
        }
        const submissions=acceptance.parts.filter(part=>part.owner==="activity"&&part.kind==="stage_submission"&&
          (part.proposal as import("@agent-anything/agent-runtime/activity").ActivityStageRequest)?.id===proposal.input.stageRequestId);
        if(submissions.length>1)reject("input_activity_submission_ambiguous");
        const request=submissions[0]?.proposal as import("@agent-anything/agent-runtime/activity").ActivityStageRequest|undefined;
        if(!request || request.id!==proposal.input.stageRequestId || request.pathId!==proposal.input.activityId ||
          modelInputValueDigest(request.input)!==modelInputValueDigest(exactInput))reject("input_activity_submission_missing");
        const stored:StoredInput={...metadata,exactInputRoot:this.retain(exactInput),exactInputDigest:modelInputValueDigest(exactInput)};
        const judgment=(acceptance.parts.find(part=>part.owner==="representation"&&part.kind==="judge"&&
          (part.proposal as import("@agent-anything/context/representation").RepresentationJudgment).id===proposal.input.combinationJudgmentId)?.proposal as import("@agent-anything/context/representation").RepresentationJudgment|undefined)
          ??this.representations.judgment(proposal.input.combinationJudgmentId);
        if(!judgment || judgment.kind!=="combination" || judgment.conclusion!=="supported" || judgment.purpose!==scope.purpose || judgment.target!==scope.target ||
          judgment.dependencies.inputDigest!==modelInputValueDigest(exactInput))reject("input_combination_not_supported");
        const deliveries=acceptance.parts.filter(p=>p.owner==="context_delivery"&&p.kind==="select"&&
          (p.proposal as {inputId?:string})?.inputId===proposal.input.id);
        if(deliveries.length>1)reject("input_delivery_part_ambiguous");
        const deliveryPart=deliveries[0];
        if(!deliveryPart || modelInputValueDigest(deliveryPart.proposal)!==modelInputValueDigest({inputId:proposal.input.id,scopeId:scope.id,deliveryIds:proposal.input.deliveries.map(d=>d.id)}))reject("input_delivery_part_missing");
        return {proposal:structuredClone(proposal),stored};
      },apply:(value,acceptance)=>{
        if(value&&typeof value==="object"&&"release" in value){
          const {release}=value as {release:import("@agent-anything/context/selection").ContextInputRetirement};
          for(const id of release.inputIds)this.retireInput(id,release.basis);
          for(const withdrawal of release.withdrawals)this.withdraw({kind:"withdraw",...withdrawal,basis:release.basis});
          return;
        }
        if(value&&typeof value==="object"&&"scope" in value){this.registerScope((value as {scope:ContextUseScope}).scope);return;}
        const {proposal,stored}=value as {proposal:ContextSelectionProposal;stored:StoredInput};
        try{this.acceptSelection(proposal,stored,acceptance);}catch(error){if(error instanceof MaterialCustodyError)reject(error.code);throw error;}
      },validate:value=>{
        if(value&&typeof value==="object"&&"release" in value)return;
        if(value&&typeof value==="object"&&"scope" in value)return;
        const {proposal}=value as {proposal:ContextSelectionProposal};
        for(const id of proposal.releaseHolds)if(this.materials.hold(id))reject("input_hold_transfer_incomplete");
      }},
      {owner:"context_delivery",kinds:["publish","select","accept","dispose","release_selection","finalize"],prepare:part=>structuredClone(part),apply:(value,acceptance)=>{
        try{this.applyDelivery(value as DeliveryPart,acceptance);}catch(error){if(error instanceof MaterialCustodyError)reject(error.code);throw error;}
      },validate:(value,acceptance)=>{
        const part=value as DeliveryPart;
        if(part.kind==="publish"&&part.proposal.lifetime)this.validateDeliveryLifetime(part.proposal,acceptance);
        if(part.kind==="finalize")this.validateDeliveryFinalization(part.proposal,acceptance,true);
        if(part.kind==="accept") {
          const {input}=this.storedInput(part.proposal.inputId);
          if(input.deliveries.some(value=>this.delivery(value.id)?.lifetime)) {
            const professional=acceptance.parts.some(value=>value.owner==="activity"&&["professional_acceptance","result_settlement"].includes(value.kind)&&
              (value.proposal as {receipt?:{id:string;requestId:string;resultId:string}}).receipt?.id===acceptance.id&&
              (value.proposal as {receipt:{requestId:string}}).receipt.requestId===input.stageRequestId&&
              (value.proposal as {receipt:{resultId:string}}).receipt.resultId===part.proposal.responseId);
            if(!professional)reject("delivery_professional_acceptance_missing");
            this.validateDeliveryResponse(input,part.proposal.responseId);
          }
        }
      }},
    ];
  }
  private registerScope(scope:ContextUseScope):ContextUseScope {
    [scope.id,scope.runId,scope.recipient,scope.purpose,scope.continuity,scope.owner,scope.target,scope.authorityBasis].forEach(custodyToken);
    return this.db.transaction(()=>{
      const old=this.records.sql("SELECT value,digest FROM context_use_scopes WHERE id=?").get(scope.id) as {value:string;digest:string}|undefined;
      if(old){requireSame(checkedJson(old),scope);return scope;}
      const control={scopeId:scope.id,revision:0,allowed:true,basis:scope.authorityBasis};
      this.records.sql("INSERT INTO context_use_scopes VALUES (?,?,?,?,?,?,?,NULL)").run(scope.id,
        JSON.stringify([scope.runId,scope.recipient,scope.purpose,scope.continuity]),scope.runId,JSON.stringify(scope),modelInputValueDigest(scope),JSON.stringify(control),modelInputValueDigest(control));
      this.deliveryFacts.register(scope);
      this.selectionFact(scope.runId,scope.id,"scope_registered",{scope},[],scope);return scope;
    })();
  }
  private scope(id:string):{scope:ContextUseScope;control:ContextUseControl;currentId:string|null} {
    const row=this.records.sql("SELECT value,digest,control,control_digest,current_id FROM context_use_scopes WHERE id=?").get(id) as {value:string;digest:string;control:string;control_digest:string;current_id:string|null}|undefined;
    if(!row)reject("input_scope_missing");
    return {scope:checkedJson(row),control:checkedJson({value:row.control,digest:row.control_digest}),currentId:row.current_id};
  }
  private control(control:ContextUseControl,expectedRevision:number):ContextUseControl {
    custodyToken(control.basis);
    return this.db.transaction(()=>{
      const current=this.scope(control.scopeId);
      if(current.control.revision===control.revision){requireSame(current.control,control);return control;}
      if(current.control.revision!==expectedRevision || control.revision!==expectedRevision+1)reject("input_control_conflict");
      this.records.sql("UPDATE context_use_scopes SET control=?,control_digest=? WHERE id=?").run(JSON.stringify(control),modelInputValueDigest(control),control.scopeId);
      this.selectionFact(current.scope.runId,control.scopeId,"control_changed",{control},[],current.scope);return control;
    })();
  }
  private selection(id:string):Selection {
    const row=this.records.sql("SELECT value,digest FROM context_selection_versions WHERE id=?").get(id) as {value:string;digest:string}|undefined;
    if(!row)reject("selection_missing");return checkedJson<Selection>(row);
  }
  private storedInput(id:string):{input:StoredInput;acceptanceId:string;retired:string|null} {
    const row=this.records.sql("SELECT value,digest,acceptance_id,retired FROM context_input_bindings WHERE id=?").get(id) as {value:string;digest:string;acceptance_id:string;retired:string|null}|undefined;
    if(!row)reject("input_binding_missing");return {input:checkedJson(row),acceptanceId:row.acceptance_id,retired:row.retired};
  }
  private acceptSelection(proposal:ContextSelectionProposal,input:StoredInput,acceptance:SharedAcceptanceProposal):void {
    const current=this.scope(proposal.scopeId),scope=current.scope;
    if(!current.control.allowed || current.control.revision!==proposal.expectedControlRevision)reject("input_control_changed");
    if(current.currentId!==proposal.expectedSelectionId)reject("selection_conflict");
    const selection=proposal.selection??(current.currentId?this.selection(current.currentId):null);
    if(!selection || selection.id!==input.selectionId || input.scopeId!==scope.id || input.target!==scope.target || !selection.representations.length || selection.representations.length>256)reject("input_selection_invalid");
    const combination=this.representations.judgment(input.combinationJudgmentId)!;
    if(modelInputValueDigest(combination.subjects)!==modelInputValueDigest(selection.representations))reject("input_combination_subjects_changed");
    for(const judgmentId of selection.judgmentIds) {
      const judgment=this.representations.judgment(judgmentId);
      if(!judgment || judgment.conclusion!=="supported" || judgment.target!==scope.target || judgment.purpose!==scope.purpose)reject("selection_judgment_unavailable");
    }
    const ranges:MaterialRange[]=[];
    for(const ref of selection.representations) {
      const representation=this.representations.read(ref);if(!representation)reject("selection_representation_missing");
      ranges.push(representation.body,...representation.details,...representation.inputs.map(input=>input.material));
    }
    for(const range of ranges) {
      const hold=selection.holds.find(h=>containsMaterialRange(h.range,range));
      if(!hold || hold.responsibility!=="selection" || hold.basis!==selection.id)reject("selection_hold_missing");
      if(modelInputValueDigest(this.materials.hold(hold.id))!==modelInputValueDigest(hold))reject("selection_hold_identity_mismatch");
      this.materials.requireProtected(hold.instanceId,range,scope,hold.id);
    }
    for(const selected of input.deliveries) {const delivery=this.delivery(selected.id);if(!delivery)reject("delivery_missing");ranges.push(delivery.material);}
    for(const range of ranges) {
      const hold=input.holds.find(h=>containsMaterialRange(h.range,range));if(!hold)reject("input_hold_missing");
      if(modelInputValueDigest(this.materials.hold(hold.id))!==modelInputValueDigest(hold))reject("input_hold_identity_mismatch");
      this.materials.requireProtected(hold.instanceId,range,scope,hold.id);
      if(hold.responsibility!=="input" || hold.basis!==input.id)reject("input_hold_responsibility_invalid");
    }
    if(proposal.selection) {
      this.records.sql("INSERT INTO context_selection_versions VALUES (?,?,?,?,?)").run(selection.id,scope.id,acceptance.id,JSON.stringify(selection),modelInputValueDigest(selection));
      this.records.sql("UPDATE context_use_scopes SET current_id=? WHERE id=?").run(selection.id,scope.id);
    }
    this.records.sql("INSERT INTO context_input_bindings VALUES (?,?,?,?,?,NULL)").run(input.id,scope.id,acceptance.id,JSON.stringify(input),modelInputValueDigest(input));
    const subject=object("context_selection",input.id,scope.runId),selected=object("context_selection",selection.id,scope.runId);
    this.selectionFact(scope.runId,input.id,"input_bound",{acceptanceId:acceptance.id,scopeId:scope.id,selectionId:selection.id,activityId:input.activityId,
      stageRequestId:input.stageRequestId,deliveries:input.deliveries,deliveryIds:input.deliveries.map(d=>d.id),holds:input.holds.map(h=>h.id),changedSelection:proposal.selection!==null,
      exactInputDigest:input.exactInputDigest,combinationJudgmentId:input.combinationJudgmentId},[
      relation("observes",subject,object("shared_acceptance",acceptance.id,acceptance.scope)),
      relation("includes",object("context_selection",scope.id,scope.runId),selected),relation("observes",subject,selected),
      relation("observes",subject,object("activity",input.activityId,scope.runId)),relation("observes",subject,object("activity",input.stageRequestId,scope.runId)),
      relation("observes",subject,object("representation",input.combinationJudgmentId,scope.runId)),
      ...selection.representations.map(ref=>relation("includes",selected,object("representation",JSON.stringify([ref.id,ref.revision]),scope.runId))),
      ...input.deliveries.map(delivery=>relation("includes",subject,object("context_delivery",delivery.id,scope.runId),"selected_for_input")),
      ...input.holds.map(hold=>relation("observes",subject,object("material_custody",hold.id,hold.consumer.runId))),
    ],scope,{basis:"accepted_input_retained_selection_and_judgment",input:proposal.selection===null?1:0,
      content:proposal.selection===null?selection.representations.length:0,
      checks:acceptance.parts.some(part=>part.owner==="representation"&&part.kind==="judge"&&(part.proposal as {id?:string}).id===input.combinationJudgmentId)?0:1});
  }
  private binding(id:string,checkCurrentControl:boolean):ContextSelectionSnapshot {
    // Read all related metadata in one view, then hydrate the immutable body outside it.
    const metadata=this.db.transaction(()=>{
      const {input,acceptanceId,retired}=this.storedInput(id),current=this.scope(input.scopeId);
      if(checkCurrentControl&&retired!==null)reject("input_retired");
      if(checkCurrentControl&&!current.control.allowed)reject("input_control_revoked");
      if(checkCurrentControl)for(const hold of input.holds)this.materials.requireProtected(hold.instanceId,hold.range,current.scope,hold.id);
      return {input,acceptanceId,scope:current.scope,selection:this.selection(input.selectionId),deliveries:input.deliveries.map(d=>{
        const value=this.delivery(d.id);if(!value)reject("input_delivery_missing");return value;
      })};
    })();
    const {exactInputRoot,exactInputDigest,...input}=metadata.input;
    const exactInput=this.hydrate(exactInputRoot);
    if(modelInputValueDigest(exactInput)!==exactInputDigest)reject("input_content_corrupt");
    return {...metadata,input:{...input,exactInput}};
  }
  private delivery(id:string):ContextDelivery|null {
    const row=this.records.sql("SELECT value,digest FROM context_recipient_deliveries WHERE id=?").get(id) as {value:string;digest:string}|undefined;
    return row?checkedJson<ContextDelivery>(row):null;
  }
  private deliveryState(id:string):ContextDeliveryState|null {
    custodyToken(id);
    const row=this.records.sql("SELECT value,digest,input_id,accepted_response,disposition FROM context_recipient_deliveries WHERE id=?").get(id) as
      {value:string;digest:string;input_id:string|null;accepted_response:string|null;disposition:string|null}|undefined;
    if(!row)return null;
    const delivery=checkedJson<ContextDelivery>(row),input=row.input_id?this.storedInput(row.input_id).input:null;
    if(delivery.id!==id||input&&(!input.deliveries.some(value=>value.id===id)||recipientKey(this.scope(input.scopeId).scope)!==recipientKey(delivery.recipient)))
      reject("delivery_state_binding_invalid");
    return {delivery,selectedInputId:row.input_id,selectedPathId:input?.activityId??null,selectionSettled:!input||this.pathSettled(input.activityId),
      acceptedResponseId:row.accepted_response,disposition:row.disposition?JSON.parse(row.disposition) as ContextDeliveryState["disposition"]:null};
  }
  private validateDeliveryLifetime(delivery:ContextDelivery,acceptance:SharedAcceptanceProposal):void {
    const lifetime=delivery.lifetime;
    if(!lifetime||lifetime.owner!==acceptance.actor||delivery.recipient.runId!==acceptance.scope||lifetime.scope.source.runId!==acceptance.scope)
      reject("delivery_lifecycle_owner_invalid");
    const path=this.consumer(lifetime.sourcePathId),stage=this.deliveryLifetime.stage(`${lifetime.sourcePathId}:capture`);
    if(!path||!stage||path.intent.owner!==lifetime.owner||path.intent.runId!==acceptance.scope||sourceMaterialOutcome(path,stage)?.kind!=="published_source_material")
      reject("delivery_lifecycle_publication_missing");
    const request=stage.request.input as SourceMaterialPublicationRequest;
    const declared=request.deliveries?.find(value=>value.id===delivery.id);
    const expected={...declared,sourceRunId:request.intent.version.origin.runId,recipient:request.recipient,
      material:{...request.intent.version.ref,start:0,end:request.intent.version.bytes,coordinate:"bytes"},instanceId:request.intent.instanceId,
      holdId:`${request.intent.id}:delivery-hold:${modelInputValueDigest(delivery.id)}`,detailHoldId:null,
      lifetime:{owner:path.intent.owner,sourcePathId:path.intent.id,subscriptionId:`${delivery.id}:lifecycle`,scope:request.deliveryLifetime}};
    if(!declared||modelInputValueDigest(delivery)!==modelInputValueDigest(expected))reject("delivery_lifecycle_declaration_changed");
    const state=this.deliveryLifetime.subscription(lifetime.subscriptionId),sub=state?.subscription;
    const sources=[contextDeliveryFactSource(delivery.recipient).id,lifetime.scope.source.id,activityFactSourceId("control",path.intent.id)];
    if(!sub||sub.runId!==acceptance.scope||sub.owner!==lifetime.owner||sub.binding?.kind!=="activity_path"||sub.binding.id!==path.intent.id||
      modelInputValueDigest([...sub.sources].sort())!==modelInputValueDigest(sources.sort()))reject("delivery_lifecycle_subscription_missing");
  }
  private validateDeliveryFinalization(proposal:ContextDeliveryFinalization,acceptance:SharedAcceptanceProposal,applied:boolean):ContextDeliveryState {
    const state=this.deliveryState(proposal.deliveryId);if(!state)reject("delivery_missing");
    this.validateDeliveryLifetime(state.delivery,acceptance);
    const lifetime=state.delivery.lifetime!;
    const closure=acceptance.parts.find(part=>part.owner==="activity"&&part.kind==="reconsideration_acceptance"&&
      (part.proposal as ActivityReconsiderationReceipt).subscriptionId===lifetime.subscriptionId)?.proposal as ActivityReconsiderationReceipt|undefined;
    if(!closure?.close||closure.id!==acceptance.id)reject("delivery_lifecycle_closure_missing");
    const original=proposal.expected;
    let disposition=original.disposition;
    if(original.acceptedResponseId===null&&disposition===null) {
      const fact=proposal.closedFactId===lifetime.scope.closedFactId?this.deliveryLifetime.readFact(proposal.closedFactId):null;
      if(!fact||fact.sourceId!==lifetime.scope.source.id||fact.ref.owner!==lifetime.scope.source.owner)reject("delivery_lifecycle_scope_open");
      if(!state.selectionSettled)reject("delivery_disposition_unsettled");
      if(applied)disposition={reason:"withdrawn",basis:fact.id};
    } else if(proposal.closedFactId!==null)reject("delivery_lifecycle_basis_invalid");
    if(state.selectedInputId!==original.selectedInputId||state.acceptedResponseId!==original.acceptedResponseId||
      modelInputValueDigest(state.disposition)!==modelInputValueDigest(disposition))reject("delivery_lifecycle_state_changed");
    if(state.acceptedResponseId!==null) {
      if(!state.selectedInputId)reject("delivery_response_not_confirmed");
      const {input}=this.storedInput(state.selectedInputId);
      this.validateDeliveryResponse(input,state.acceptedResponseId);
    }
    if(applied&&(!this.deliveryLifetime.subscription(lifetime.subscriptionId)?.closed||this.materials.hold(state.delivery.holdId)))
      reject("delivery_lifecycle_release_incomplete");
    return state;
  }
  private validateDeliveryResponse(input:StoredInput,responseId:string):void {
    const scope=this.scope(input.scopeId).scope,stage=this.deliveryLifetime.stage(input.stageRequestId);
    if(!stage||stage.request.pathId!==input.activityId||!this.confirmResult(scope.runId,input.activityId,input.exactInputDigest,responseId)||
      !(stage.status==="accepted"&&stage.receipt?.resultId===responseId||stage.status==="settled"&&stage.settlement?.resultId===responseId))
      reject("delivery_response_not_confirmed");
  }
  private recordDelivery(recipient:MaterialRecipient,id:string,transition:ContextDeliveryTransition,
    details:{inputId?:string;responseId?:string;detailHoldId?:string|null;sourceRunId?:string;sourceId?:string;material?:MaterialRange;holdId?:string;reason?:string;basis?:string},
    acceptance:SharedAcceptanceProposal):void {
    const delivery=this.delivery(id)!;
    const subject=object("context_delivery",id,recipient.runId);
    const relationships=[relation("observes",subject,object("shared_acceptance",acceptance.id,acceptance.scope)),
      relation("observes",subject,object("material_custody",delivery.material.materialId,null,delivery.material.version)),
      relation("observes",subject,object("material_custody",delivery.instanceId,delivery.sourceRunId)),
      relation("observes",subject,object("material_custody",delivery.holdId,recipient.runId))];
    if(delivery.lifetime)relationships.push(relation("observes",subject,object("activity",delivery.lifetime.sourcePathId,delivery.sourceRunId)),
      relation("observes",subject,object("activity",delivery.lifetime.subscriptionId,delivery.sourceRunId)));
    if(details.inputId)relationships.push(relation(transition==="accepted"?"delivers":"observes",subject,
      object("context_selection",details.inputId,recipient.runId),transition==="accepted"?"purpose_accepted":transition));
    if(details.responseId)relationships.push(relation("observes",subject,object("activity",details.responseId,recipient.runId)));
    if(details.detailHoldId)relationships.push(relation("observes",subject,object("material_custody",details.detailHoldId,recipient.runId)));
    this.records.fact(recipient.runId,"context_delivery",id,transition,{...details,delivery,acceptanceId:acceptance.id,acceptanceScope:acceptance.scope},
      {revision:"1",category:"delivery",subject,scope:{purpose:recipient.purpose,recipient},state:{phase:transition==="accepted"||transition==="disposed"?"settled":"pending",status:transition},related:[],relationships});
    this.deliveryFacts.publish(recipient,id,transition,acceptance.id);
  }
  private applyDelivery(part:DeliveryPart,acceptance:SharedAcceptanceProposal):void {
    if(part.kind==="finalize") {
      const state=this.validateDeliveryFinalization(part.proposal,acceptance,false),delivery=state.delivery;
      if(state.acceptedResponseId===null&&state.disposition===null) {
        const disposition={reason:"withdrawn",basis:part.proposal.closedFactId!};
        this.records.sql("UPDATE context_recipient_deliveries SET disposition=? WHERE id=?").run(JSON.stringify(disposition),delivery.id);
        this.recordDelivery(delivery.recipient,delivery.id,"disposed",disposition,acceptance);
      }
      if(this.materials.hold(delivery.holdId))this.materials.command({kind:"release",holdId:delivery.holdId,basis:acceptance.id});
    } else if(part.kind==="release_selection") {
      const {inputId,basis}=part.proposal;custodyToken(basis);
      const {input}=this.storedInput(inputId),scope=this.scope(input.scopeId).scope;
      const consumer=this.consumer(input.activityId);
      if(!consumer||consumer.intent.runId!==scope.runId||acceptance.scope!==scope.runId ||
        (acceptance.actor!==scope.owner&&acceptance.actor!==consumer.intent.purpose.contract.recoveryOwner))reject("delivery_release_actor_invalid");
      if(!this.pathSettled(input.activityId))reject("delivery_release_unsettled");
      for(const selected of input.deliveries) {
        const row=this.records.sql("SELECT input_id,accepted_response,disposition FROM context_recipient_deliveries WHERE id=?").get(selected.id) as {input_id:string|null;accepted_response:string|null;disposition:string|null}|undefined;
        if(!row || row.input_id!==inputId || row.accepted_response!==null || row.disposition!==null)reject("delivery_release_conflict");
        this.records.sql("UPDATE context_recipient_deliveries SET input_id=NULL WHERE id=?").run(selected.id);
        this.recordDelivery(scope,selected.id,"selection_released",{inputId,basis},acceptance);
      }
    } else if(part.kind==="dispose") {
      const {deliveryId,recipient,reason,basis}=part.proposal;custodyToken(basis);
      const delivery=this.delivery(deliveryId);
      if(!delivery || recipientKey(delivery.recipient)!==recipientKey(recipient) || acceptance.scope!==recipient.runId || acceptance.actor!==recipient.recipient || !["cancelled","withdrawn","unavailable"].includes(reason))reject("delivery_disposition_invalid");
      const row=this.records.sql("SELECT input_id,accepted_response,disposition FROM context_recipient_deliveries WHERE id=?").get(deliveryId) as {input_id:string|null;accepted_response:string|null;disposition:string|null};
      const disposition=JSON.stringify({reason,basis});
      if(row.disposition!==null){if(row.disposition!==disposition)reject("delivery_disposition_conflict");return;}
      if(row.accepted_response!==null || row.input_id!==null&&!this.pathSettled(this.storedInput(row.input_id).input.activityId))reject("delivery_disposition_unsettled");
      this.records.sql("UPDATE context_recipient_deliveries SET disposition=? WHERE id=?").run(disposition,deliveryId);
      this.recordDelivery(recipient,deliveryId,"disposed",{reason,basis},acceptance);
    } else if(part.kind==="publish") {
      const delivery=part.proposal,hold=this.materials.hold(delivery.holdId);
      const version=this.materials.version(delivery.material.materialId,delivery.material.version);
      if(!version || version.origin.runId!==delivery.sourceRunId || !hold || hold.responsibility!=="delivery" || hold.instanceId!==delivery.instanceId || hold.basis!==delivery.id)reject("delivery_source_or_hold_invalid");
      this.materials.requireProtected(delivery.instanceId,delivery.material,delivery.recipient,delivery.holdId);
      const old=this.delivery(delivery.id);if(old){requireSame(old,delivery);return;}
      this.records.sql("INSERT INTO context_recipient_deliveries VALUES (?,?,?,?,NULL,NULL,NULL)").run(delivery.id,recipientKey(delivery.recipient),JSON.stringify(delivery),modelInputValueDigest(delivery));
      this.recordDelivery(delivery.recipient,delivery.id,"published",{sourceRunId:delivery.sourceRunId,sourceId:delivery.sourceId,material:delivery.material,holdId:delivery.holdId},acceptance);
    } else if(part.kind==="select") {
      const scope=this.scope(part.proposal.scopeId).scope,{input,acceptanceId}=this.storedInput(part.proposal.inputId);
      if(acceptanceId!==acceptance.id || input.scopeId!==scope.id || modelInputValueDigest(input.deliveries.map(d=>d.id))!==modelInputValueDigest(part.proposal.deliveryIds))reject("delivery_input_mismatch");
      for(const id of part.proposal.deliveryIds) {
        const row=this.records.sql("SELECT value,digest,recipient_key,input_id,accepted_response,disposition FROM context_recipient_deliveries WHERE id=?").get(id) as {value:string;digest:string;recipient_key:string;input_id:string|null;accepted_response:string|null;disposition:string|null}|undefined;
        if(!row || row.recipient_key!==recipientKey(scope) || row.input_id!==null || row.accepted_response!==null || row.disposition!==null)reject("delivery_selection_conflict");
        checkedJson(row);
        this.records.sql("UPDATE context_recipient_deliveries SET input_id=? WHERE id=?").run(input.id,id);
        this.recordDelivery(scope,id,"selected",{inputId:input.id},acceptance);
      }
    } else {
      const {input}=this.storedInput(part.proposal.inputId),scope=this.scope(input.scopeId).scope;
      const consumer=this.consumer(input.activityId);
      if(!consumer||consumer.intent.runId!==scope.runId||acceptance.scope!==scope.runId ||
        acceptance.actor!==consumer.intent.purpose.contract.acceptanceOwner ||
        !this.records.sql("SELECT 1 FROM context_input_sends WHERE input_id=?").get(input.id))reject("delivery_not_sent");
      if(!this.confirmResult(scope.runId,input.activityId,input.exactInputDigest,part.proposal.responseId))reject("delivery_response_not_confirmed");
      for(const selected of input.deliveries) {
        const delivery=this.delivery(selected.id)!;
        const prior=this.records.sql("SELECT input_id,accepted_response,disposition FROM context_recipient_deliveries WHERE id=?").get(selected.id) as {input_id:string|null;accepted_response:string|null;disposition:string|null};
        if(prior.input_id!==input.id)reject("delivery_selection_changed");
        if(prior.disposition!==null)reject("delivery_disposed");
        if(prior.accepted_response!==null){if(prior.accepted_response!==part.proposal.responseId)reject("delivery_response_conflict");continue;}
        if(delivery.detailHoldId) {
          const hold=this.materials.hold(delivery.detailHoldId);
          if(!part.proposal.detailHolds.includes(delivery.detailHoldId) || !hold || hold.responsibility!=="detail")reject("delivery_detail_promise_missing");
          this.materials.requireProtected(hold.instanceId,delivery.material,delivery.recipient,hold.id);
        }
        this.records.sql("UPDATE context_recipient_deliveries SET accepted_response=? WHERE id=? AND input_id=? AND accepted_response IS NULL").run(part.proposal.responseId,selected.id,input.id);
        this.recordDelivery(scope,selected.id,"accepted",{inputId:input.id,responseId:part.proposal.responseId,detailHoldId:delivery.detailHoldId},acceptance);
      }
    }
  }
  private pendingDeliveries(command:Extract<ContextSelectionCommand,{kind:"pending_deliveries"}>):ContextDeliveryPage {
    const {recipient,after,limit}=command;
    [recipient.runId,recipient.recipient,recipient.purpose].forEach(custodyToken);
    if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>256||
      command.through!==null&&(!Number.isSafeInteger(command.through)||command.through<after))reject("delivery_page_invalid");
    return this.db.transaction(()=>{
      const key=recipientKey(recipient),through=command.through??(this.records.sql("SELECT COALESCE(MAX(rowid),0) AS n FROM context_recipient_deliveries WHERE recipient_key=?").get(key) as {n:number}).n;
      const rows=this.records.sql("SELECT rowid AS sequence,value,digest,input_id FROM context_recipient_deliveries WHERE recipient_key=? AND rowid>? AND rowid<=? AND accepted_response IS NULL AND disposition IS NULL ORDER BY rowid LIMIT ?")
        .all(key,after,through,limit+1) as {sequence:number;value:string;digest:string;input_id:string|null}[];
      const entries=rows.slice(0,limit).map(row=>({sequence:row.sequence,delivery:checkedJson<ContextDelivery>(row),selectedInputId:row.input_id}));
      return {through,nextAfter:rows.length>limit?entries.at(-1)!.sequence:null,entries};
    })();
  }
  private sent(inputId:string,attemptId:string):null {
    custodyToken(attemptId);
    this.db.transaction(()=>{
      const {input,retired}=this.storedInput(inputId),scope=this.scope(input.scopeId);
      if(retired!==null)reject("input_retired");
      if(!scope.control.allowed)reject("input_control_revoked");
      if(!this.confirmAttempt(scope.scope.runId,input.activityId,input.stageRequestId,input.exactInputDigest,attemptId))reject("input_attempt_not_confirmed");
      for(const hold of input.holds)this.materials.requireProtected(hold.instanceId,hold.range,scope.scope,hold.id);
      const result=this.records.sql("INSERT OR IGNORE INTO context_input_sends VALUES (?,?)").run(inputId,attemptId);
      if(result.changes)this.selectionFact(scope.scope.runId,input.id,"sent",{attemptId,activityId:input.activityId,stageRequestId:input.stageRequestId},[
        relation("delivers",object("context_selection",input.id,scope.scope.runId),object("activity",attemptId,scope.scope.runId),"input_sent"),
        relation("observes",object("context_selection",input.id,scope.scope.runId),object("activity",input.stageRequestId,scope.scope.runId)),
      ],scope.scope);
    })();return null;
  }
  mayRelease(hold:MaterialHold):boolean {
    if(hold.responsibility==="input")return !this.records.sql("SELECT 1 FROM context_input_bindings WHERE id=? AND retired IS NULL").get(hold.basis);
    if(hold.responsibility==="selection")return !this.records.sql("SELECT 1 FROM context_use_scopes WHERE current_id=?").get(hold.basis);
    if(hold.responsibility==="delivery")return !this.records.sql("SELECT 1 FROM context_recipient_deliveries WHERE id=? AND accepted_response IS NULL AND disposition IS NULL").get(hold.basis);
    return true;
  }
  private retireInput(id:string,basis:string):null {
    custodyToken(basis);
    this.db.transaction(()=>{
      const {input,retired}=this.storedInput(id),scope=this.scope(input.scopeId).scope;
      if(retired!==null){if(retired!==basis)reject("input_retirement_conflict");return;}
      if(!this.pathSettled(input.activityId) || this.records.sql("SELECT 1 FROM context_recipient_deliveries WHERE input_id=? AND accepted_response IS NULL AND disposition IS NULL").get(id))reject("input_responsibility_unsettled");
      this.records.sql("UPDATE context_input_bindings SET retired=? WHERE id=? AND retired IS NULL").run(basis,id);
      this.selectionFact(scope.runId,id,"input_retired",{basis},[],scope);
    })();return null;
  }
  private withdraw(command:Extract<ContextSelectionCommand,{kind:"withdraw"}>):null {
    custodyToken(command.basis);
    this.db.transaction(()=>{
      const current=this.scope(command.scopeId);
      if(current.currentId!==command.expectedSelectionId || current.control.revision!==command.expectedControlRevision)reject("selection_withdraw_conflict");
      this.records.sql("UPDATE context_use_scopes SET current_id=NULL WHERE id=?").run(command.scopeId);
      this.selectionFact(current.scope.runId,command.scopeId,"selection_withdrawn",{selectionId:command.expectedSelectionId,basis:command.basis},[
        relation("observes",object("context_selection",command.scopeId,current.scope.runId),object("context_selection",command.expectedSelectionId,current.scope.runId)),
      ],current.scope);
    })();return null;
  }
  private selectionFact(runId:string,id:string,status:string,details:Readonly<Record<string,unknown>>,relationships:readonly ContextProcessRelationship[],scope:ContextUseScope,reuse?:import("@agent-anything/context/evidence").ContextProcessEvidence["reuse"]):void {
    this.records.fact(runId,"context_selection",id,status,details,{revision:"1",category:"selection",subject:object("context_selection",id,runId),
      scope:{purpose:scope.purpose,recipient:{runId:scope.runId,recipient:scope.recipient,purpose:scope.purpose}},...(reuse?{reuse}:{}),state:{phase:status==="input_retired"?"settled":"pending",status},related:[],relationships});
  }
}
function recipientKey(recipient:{runId:string;recipient:string;purpose:string}):string{return JSON.stringify([recipient.runId,recipient.recipient,recipient.purpose]);}
function reject(code:string):never{throw new SharedAcceptanceRejection("context_selection",code);}

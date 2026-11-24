import type Database from "better-sqlite3";
import {randomUUID} from "node:crypto";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {snapshotMaterialDeliveryObligation,snapshotMaterialDeliveryDisposition,containsMaterialRange,custodyToken,
  type MaterialDeliveryPart,type MaterialDeliveryQuery,type MaterialDeliveryValue,type MaterialDeliveryState,
  type MaterialDeliveryEvidence,type MaterialDeliveryTransferReceipt,type MaterialDispositionRef,type MaterialHold,
  type MaterialDeliveryGuard,type MaterialDeliveryDispositionAcceptance,type MaterialDeliveryObligation,type MaterialRange} from "@agent-anything/context/custody";
import {checkedJson} from "./ContextFoundationRecords.js";
import {SharedAcceptanceRejection,type SharedAcceptanceParticipant} from "./SharedAcceptanceDatabase.js";
import type {MaterialCustodyDatabase} from "./MaterialCustodyDatabase.js";

export const MATERIAL_DELIVERY_SCHEMA=`
CREATE TABLE material_delivery_store(id TEXT PRIMARY KEY);
CREATE TABLE material_delivery_obligations(id TEXT PRIMARY KEY,hold_id TEXT NOT NULL UNIQUE,value TEXT NOT NULL,digest TEXT NOT NULL);
CREATE TABLE material_delivery_evidence(id TEXT NOT NULL,revision TEXT NOT NULL,value TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(id,revision));
CREATE TABLE material_delivery_dispositions(id TEXT NOT NULL,revision TEXT NOT NULL,request_digest TEXT NOT NULL,value TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(id,revision));
CREATE TABLE material_delivery_transfers(id TEXT PRIMARY KEY,value TEXT NOT NULL,digest TEXT NOT NULL);
CREATE TABLE material_delivery_facts(sequence INTEGER PRIMARY KEY,run_id TEXT NOT NULL,value TEXT NOT NULL,digest TEXT NOT NULL);
`;
export const MATERIAL_DELIVERY_OBJECTS=["material_delivery_store","material_delivery_obligations","material_delivery_evidence","material_delivery_dispositions","material_delivery_transfers","material_delivery_facts"];
export const MATERIAL_DELIVERY_ACCESS_SCHEMA=`
CREATE INDEX material_delivery_owner ON material_delivery_obligations(json_extract(value,'$.obligation.contract.owner'),id);
CREATE INDEX material_delivery_receipts ON material_delivery_evidence(json_extract(value,'$.obligation.id'),json_extract(value,'$.kind'),id,revision);
CREATE INDEX material_delivery_discharge ON material_delivery_dispositions(json_extract(value,'$.disposition.obligation.id'),id,revision);
`;
export const MATERIAL_DELIVERY_ACCESS_OBJECTS=["material_delivery_owner","material_delivery_receipts","material_delivery_discharge"];
export interface MaterialDeliveryFact {readonly sequence:number;readonly runId:string;readonly activityId:string;readonly kind:string;readonly identity:string;readonly occurredAt:string;readonly value:unknown;}

/** Owns delivery obligations, not the semantic meaning of an owner's receipt. */
export class MaterialDeliveryDatabase {
  private cursor:number|null=null;
  private readonly statements=new Map<string,Database.Statement>();
  constructor(private readonly db:Database.Database,private readonly materials:MaterialCustodyDatabase,
    private readonly selectionGuard:(hold:MaterialHold)=>MaterialDeliveryGuard) {}
  private sql(sql:string){let s=this.statements.get(sql);if(!s){s=this.db.prepare(sql);this.statements.set(sql,s);}return s;}
  private read<T>(table:string,key:string,args:readonly string[]):T|null {
    const row=this.sql(`SELECT value,digest FROM ${table} WHERE ${key}`).get(...args) as {value:string;digest:string}|undefined;
    return row?checkedJson<T>(row):null;
  }
  private write(table:string,columns:readonly string[],keys:readonly string[],value:unknown,update=false):void {
    this.sql(`INSERT INTO ${table}(${[...columns,"value","digest"].join(",")}) VALUES (${[...columns,"value","digest"].map(()=>"?").join(",")})${update?" ON CONFLICT DO UPDATE SET value=excluded.value,digest=excluded.digest":""}`)
      .run(...keys,JSON.stringify(value),modelInputValueDigest(value));
  }
  identity():string {
    const rows=this.sql("SELECT id FROM material_delivery_store").all() as {id:string}[];
    if(rows.length>1)fail("store_identity_corrupt");
    if(rows.length)return rows[0]!.id;
    const id=randomUUID();this.sql("INSERT INTO material_delivery_store VALUES (?)").run(id);return id;
  }
  query(query:MaterialDeliveryQuery):MaterialDeliveryValue {
    switch(query.kind){
      case "store_identity":return this.identity();
      case "pending_page":{
        this.page(query.after,query.limit);custodyToken(query.owner);
        const rows=this.sql(`SELECT o.id,o.value,o.digest FROM material_delivery_obligations o
          JOIN material_holds h ON h.id=o.hold_id WHERE json_extract(o.value,'$.obligation.contract.owner')=? AND o.id>? AND h.released IS NULL
          ORDER BY o.id LIMIT ?`).all(query.owner,query.after??"",query.limit+1) as {id:string;value:string;digest:string}[];
        const entries=rows.slice(0,query.limit).map(row=>{
          const state=checkedJson<MaterialDeliveryState>(row);snapshotMaterialDeliveryObligation(state.obligation);
          if(state.obligation.ref.id!==row.id||state.obligation.contract.owner!==query.owner||!this.materials.hold(state.obligation.holdId))fail("discovery_identity_invalid");
          return state;
        });
        return {entries,next:rows.length>query.limit?rows[query.limit-1]!.id:null};
      }
      case "receipt_page":{
        this.page(query.after,query.limit);this.required(query.obligation);
        const cursor=this.revisionCursor(query.after);
        const rows=this.sql(`SELECT id,revision,value,digest FROM material_delivery_evidence
          WHERE json_extract(value,'$.obligation.id')=? AND json_extract(value,'$.kind')='receipt' AND (id,revision)>(?,?) ORDER BY id,revision LIMIT ?`)
          .all(query.obligation.id,...cursor,query.limit+1) as {id:string;revision:string;value:string;digest:string}[];
        const entries=rows.slice(0,query.limit).map(row=>{
          const value=checkedJson<MaterialDeliveryEvidence>(row);
          if(value.ref.id!==row.id||value.ref.revision!==row.revision||value.kind!=="receipt"||!same(value.obligation,query.obligation))fail("discovery_identity_invalid");return value;
        });
        const last=rows[query.limit-1];return {entries,next:rows.length>query.limit?JSON.stringify([last!.id,last!.revision]):null};
      }
      case "disposition_page":{
        this.page(query.after,query.limit);this.required(query.obligation);
        const cursor=this.revisionCursor(query.after);
        const rows=this.sql(`SELECT id,revision,value,digest FROM material_delivery_dispositions
          WHERE json_extract(value,'$.disposition.obligation.id')=? AND (id,revision)>(?,?) ORDER BY id,revision LIMIT ?`)
          .all(query.obligation.id,...cursor,query.limit+1) as {id:string;revision:string;value:string;digest:string}[];
        const entries=rows.slice(0,query.limit).map(row=>{
          const value=checkedJson<MaterialDeliveryDispositionAcceptance>(row);
          if(value.request.id!==row.id||value.request.revision!==row.revision||!same(value.disposition.obligation,query.obligation))fail("discovery_identity_invalid");return value;
        });
        const last=rows[query.limit-1];return {entries,next:rows.length>query.limit?JSON.stringify([last!.id,last!.revision]):null};
      }
      case "obligation":return this.state(query.ref);
      case "guard":return this.guard(this.required(query.ref));
      case "accepted":return this.read("material_delivery_dispositions","id=? AND revision=?",[query.ref.id,query.ref.revision]);
      case "transfer":return this.read("material_delivery_transfers","id=?",[query.id]);
    }
  }
  participant():SharedAcceptanceParticipant {
    type Prepared={part:MaterialDeliveryPart;checkedSelection:{hold:MaterialHold;guard:MaterialDeliveryGuard}|null;successor:MaterialDeliveryObligation|null};
    return {owner:"material_delivery",kinds:["register","protect","evidence","disposition","import_transfer","acknowledge_transfer"],
      prepare:part=>({part:structuredClone(part),checkedSelection:null,successor:null}),apply:(value,shared)=>{
      const prepared=value as Prepared,part=prepared.part,accepted={id:shared.id,revision:"1"};
      if(part.kind==="register"){
        const obligation=snapshotMaterialDeliveryObligation(part.proposal.obligation);
        this.owner(obligation,shared.actor,shared.scope);this.protected(obligation);prepared.successor=obligation;
        const prior=this.state(obligation.ref);
        if(prior){requireSame(prior.obligation,obligation);if(prior.inboundHandoff!==(part.proposal.handoff?.id??null))fail("handoff_identity_conflict");return;}
        const handoff=part.proposal.handoff;
        if(handoff){
          custodyToken(handoff.id);custodyToken(handoff.sourceStore);
          if(handoff.receiverStore!==this.identity()||handoff.sourceStore===handoff.receiverStore)fail("transfer_store_invalid");
          requireSame(handoff.successor,obligation);snapshotMaterialDeliveryObligation(handoff.source);
          if(!containsMaterialRange(handoff.source.range,obligation.range))fail("transfer_range_invalid");
          this.write("material_delivery_transfers",["id"],[handoff.id],{...handoff,accepted});
        }
        const state:MaterialDeliveryState={obligation,accepted,discharged:[],inboundHandoff:handoff?.id??null,handoffAcknowledged:!handoff,
          protection:{revision:0,selected:false,inFlight:"none",basis:accepted}};
        this.save(state);this.fact(state,"registered",accepted,state);return;
      }
      if(part.kind==="import_transfer"){
        if(shared.actor!=="material-transfer-host")fail("transfer_host_required");
        const receipt=part.proposal,state=this.required(receipt.source.ref);
        requireSame(state.obligation,receipt.source);
        if(shared.scope!==state.obligation.recipient.runId||receipt.sourceStore!==this.identity()||receipt.receiverStore===receipt.sourceStore)fail("transfer_store_invalid");
        snapshotMaterialDeliveryObligation(receipt.successor);reference(receipt.accepted);
        const old=this.read("material_delivery_transfers","id=?",[receipt.id]);
        if(old){requireSame(old,receipt);return;}
        this.write("material_delivery_transfers",["id"],[receipt.id],receipt);this.fact(state,"receiver_acceptance_imported",accepted,receipt);return;
      }
      if(part.kind==="acknowledge_transfer"){
        if(shared.actor!=="material-transfer-host")fail("transfer_host_required");
        const receipt=this.read<MaterialDeliveryTransferReceipt>("material_delivery_transfers","id=?",[part.proposal.id]);
        if(!receipt||receipt.receiverStore!==this.identity())fail("transfer_unavailable");
        const state=this.required(receipt.successor.ref);
        if(shared.scope!==state.obligation.recipient.runId)fail("scope_invalid");
        reference(part.proposal.sourceAcceptance);
        if(!state.handoffAcknowledged){this.save({...state,handoffAcknowledged:true});this.fact(state,"source_discharge_acknowledged",accepted,part.proposal);}
        return;
      }
      const obligationRef=part.kind==="disposition"?part.proposal.expectedObligation.ref:part.proposal.obligation;
      const state=this.required(obligationRef);this.owner(state.obligation,shared.actor,shared.scope);
      if(part.kind==="protect"){
        const p=part.proposal;
        if(p.expectedRevision!==state.protection.revision||typeof p.selected!=="boolean"||!["none","pending","unknown"].includes(p.inFlight))fail("protection_conflict");
        reference(p.basis);
        if(state.discharged.length&&(p.selected||p.inFlight!=="none"))fail("discharged_obligation_cannot_reopen");
        const protection={revision:p.expectedRevision+1,selected:p.selected,inFlight:p.inFlight,basis:p.basis};
        this.save({...state,protection});this.fact(state,"protection",accepted,protection);return;
      }
      if(part.kind==="evidence"){
        const p=part.proposal;reference(p.ref);reference(p.basis);
        if(!["receipt","authorization","in_flight_resolution"].includes(p.kind))fail("evidence_kind_invalid");
        const old=this.evidence(p.ref);if(old){requireSame(old,p);return;}
        this.write("material_delivery_evidence",["id","revision"],[p.ref.id,p.ref.revision],p);this.fact(state,"evidence",p.ref,p);return;
      }
      const request=part.proposal;reference(request.ref);requireSame(state.obligation,request.expectedObligation);
      const old=this.read<MaterialDeliveryDispositionAcceptance>("material_delivery_dispositions","id=? AND revision=?",[request.ref.id,request.ref.revision]);
      if(old){
        const original=this.sql("SELECT request_digest FROM material_delivery_dispositions WHERE id=? AND revision=?").get(request.ref.id,request.ref.revision) as {request_digest:string};
        if(original.request_digest!==modelInputValueDigest(request))fail("request_identity_conflict");
        const disposition=snapshotMaterialDeliveryDisposition(state.obligation,request.disposition);requireSame(old.disposition,disposition);return;
      }
      const disposition=snapshotMaterialDeliveryDisposition(state.obligation,request.disposition),guard=this.guard(state);
      const protectedDelivery=state.protection.selected||state.protection.inFlight!=="none";
      if(guard.revision!==request.expectedSelectionRevision||protectedDelivery||
        disposition.kind!=="fulfilled"&&guard.active||!state.handoffAcknowledged)fail("disposition_protected");
      const originalHold=this.protected(state.obligation,disposition.kind==="transferred");prepared.checkedSelection={hold:originalHold,guard:this.selectionGuard(originalHold)};
      let range=state.obligation.range;
      if(disposition.kind==="fulfilled")this.requireEvidence(state,disposition.receipt,"receipt");
      else if(disposition.kind==="non_delivery"){
        this.requireEvidence(state,disposition.authorization,"authorization");this.requireEvidence(state,disposition.inFlightResolution,"in_flight_resolution");
      } else {
        range=disposition.range;
        const local=this.state(disposition.successor.ref);
        if(local){
          requireSame(local.obligation,disposition.successor);requireSame(local.accepted,disposition.acceptance);this.protected(local.obligation);
          prepared.successor=local.obligation;
          if(local.discharged.length)fail("successor_not_responsible");
        } else {
          const receipts=this.sql("SELECT value,digest FROM material_delivery_transfers").all() as {value:string;digest:string}[];
          const receipt=receipts.map(row=>checkedJson<MaterialDeliveryTransferReceipt>(row)).find(r=>same(r.accepted,disposition.acceptance)&&same(r.successor.ref,disposition.successor.ref));
          if(!receipt||receipt.sourceStore!==this.identity())fail("successor_not_accepted");
          requireSame(receipt.source,state.obligation);requireSame(receipt.successor,disposition.successor);
        }
      }
      if(disposition.kind==="transferred"&&state.discharged.some(r=>overlaps(r,range)))fail("range_already_discharged");
      const ranges=disposition.kind==="transferred"?[range]:remaining(state.obligation.range,state.discharged);
      if(!ranges.length)fail("obligation_already_discharged");
      const result:MaterialDeliveryDispositionAcceptance={request:request.ref,accepted,disposition,discharged:ranges.map(range=>({holdId:state.obligation.holdId,range,disposition:accepted}))};
      this.write("material_delivery_dispositions",["id","revision","request_digest"],[request.ref.id,request.ref.revision,modelInputValueDigest(request)],result);
      this.save({...state,discharged:[...state.discharged,...ranges]});this.fact(state,"disposition",accepted,result);
    },validate:value=>{
      const prepared=value as Prepared;
      if(prepared.checkedSelection)requireSame(prepared.checkedSelection.guard,this.selectionGuard(prepared.checkedSelection.hold));
      if(prepared.successor)this.protected(prepared.successor);
    }};
  }
  private state(ref:MaterialDispositionRef):MaterialDeliveryState|null {
    reference(ref);const state=this.read<MaterialDeliveryState>("material_delivery_obligations","id=?",[ref.id]);
    if(state&&!same(state.obligation.ref,ref))fail("obligation_revision_conflict");return state;
  }
  private page(after:string|null,limit:number):void{
    if(after!==null)custodyToken(after);
    if(!Number.isSafeInteger(limit)||limit<1||limit>128)fail("page_invalid");
  }
  private revisionCursor(after:string|null):readonly [string,string]{
    if(after===null)return ["",""];
    let value:unknown;try{value=JSON.parse(after);}catch{fail("page_invalid");}
    if(!Array.isArray(value)||value.length!==2)fail("page_invalid");
    custodyToken(value[0]);custodyToken(value[1]);return [value[0],value[1]];
  }
  private required(ref:MaterialDispositionRef):MaterialDeliveryState {const state=this.state(ref);if(!state)fail("obligation_missing");return state;}
  private save(state:MaterialDeliveryState){this.write("material_delivery_obligations",["id","hold_id"],[state.obligation.ref.id,state.obligation.holdId],state,true);}
  private protected(obligation:MaterialDeliveryObligation,needsAccess=true):MaterialHold {
    const hold=this.materials.hold(obligation.holdId);if(!hold)fail("hold_missing");
    if(needsAccess)this.materials.requireProtected(hold.instanceId,obligation.range,obligation.recipient,hold.id);
    else this.materials.requireRetained(hold.instanceId,obligation.range,obligation.recipient,hold.id);
    return hold;
  }
  private owner(obligation:MaterialDeliveryObligation,actor:string,runId:string):void {
    if(obligation.contract.owner!==actor||obligation.recipient.runId!==runId)fail("owner_invalid");
  }
  private evidence(ref:MaterialDispositionRef):MaterialDeliveryEvidence|null {return this.read("material_delivery_evidence","id=? AND revision=?",[ref.id,ref.revision]);}
  private requireEvidence(state:MaterialDeliveryState,ref:MaterialDispositionRef,kind:MaterialDeliveryEvidence["kind"]):void {
    const evidence=this.evidence(ref);if(!evidence||evidence.kind!==kind||!same(evidence.obligation,state.obligation.ref))fail("evidence_missing");
  }
  private guard(state:MaterialDeliveryState):MaterialDeliveryGuard {
    const hold=this.materials.hold(state.obligation.holdId);
    const selection=hold?this.selectionGuard(hold):{revision:"released",active:false};
    return {revision:modelInputValueDigest({selection,protection:state.protection,discharged:state.discharged,handoff:state.handoffAcknowledged}),
      active:selection.active||state.protection.selected||state.protection.inFlight!=="none"};
  }
  mayRelease(hold:MaterialHold):boolean {
    const state=this.read<MaterialDeliveryState>("material_delivery_obligations","hold_id=?",[hold.id]);
    if(!state)return true;
    if(!state.handoffAcknowledged||state.protection.selected||state.protection.inFlight!=="none")return false;
    const ranges=[...state.discharged].sort((a,b)=>a.start-b.start);let end=state.obligation.range.start;
    for(const range of ranges){if(range.start!==end)return false;end=range.end;}
    return end===state.obligation.range.end&&ranges.length>0;
  }
  private fact(state:MaterialDeliveryState,kind:string,identity:MaterialDispositionRef,value:unknown):void {
    this.cursor??=(this.sql("SELECT COALESCE(MAX(sequence),0) AS n FROM material_delivery_facts").get() as {n:number}).n;
    const fact={runId:state.obligation.recipient.runId,activityId:state.obligation.ref.id,kind:`material_delivery.${kind}`,identity:identity.id,occurredAt:new Date().toISOString(),value};
    this.write("material_delivery_facts",["run_id"],[fact.runId],fact);
  }
  facts(runId:string,after:number,limit:number):MaterialDeliveryFact[]{
    if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>128)fail("page_invalid");
    return (this.sql("SELECT sequence,value,digest FROM material_delivery_facts WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT ?").all(runId,after,limit) as {sequence:number;value:string;digest:string}[])
      .map(row=>({...checkedJson<Omit<MaterialDeliveryFact,"sequence">>(row),sequence:row.sequence}));
  }
  takeObservations():MaterialDeliveryFact[]{
    if(this.cursor===null)return [];
    const rows=this.sql("SELECT sequence,value,digest FROM material_delivery_facts WHERE sequence>? ORDER BY sequence LIMIT 128").all(this.cursor) as {sequence:number;value:string;digest:string}[];
    const facts=rows.map(row=>({...checkedJson<Omit<MaterialDeliveryFact,"sequence">>(row),sequence:row.sequence}));
    if(facts.length)this.cursor=facts.at(-1)!.sequence;return facts;
  }
}
function reference(ref:MaterialDispositionRef):void {custodyToken(ref.id);custodyToken(ref.revision);}
function same(a:MaterialDispositionRef,b:MaterialDispositionRef):boolean{return a.id===b.id&&a.revision===b.revision;}
function overlaps(a:MaterialRange,b:MaterialRange):boolean{return a.materialId===b.materialId&&a.version===b.version&&((a.start<b.end&&b.start<a.end)||(a.start===a.end&&a.start===b.start));}
function remaining(range:MaterialRange,discharged:readonly MaterialRange[]):MaterialRange[]{
  if(range.start===range.end)return discharged.length?[]:[range];
  const result:MaterialRange[]=[];let start=range.start;
  for(const part of [...discharged].sort((a,b)=>a.start-b.start)){if(part.start>start)result.push({...range,start,end:part.start});start=part.end;}
  if(start<range.end)result.push({...range,start});return result;
}
function fail(code:string):never {throw new SharedAcceptanceRejection("material_delivery",`material_delivery_${code}`);}
function requireSame(a:unknown,b:unknown):void {if(modelInputValueDigest(a)!==modelInputValueDigest(b))fail("identity_conflict");}

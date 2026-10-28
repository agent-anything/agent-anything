import type Database from "better-sqlite3";
import {createHash} from "node:crypto";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {MaterialCustodyError,custodyToken,custodyCount,containsMaterialRange,sameMaterialVersion,
  type MaterialAccess,type MaterialCustodyCommand,type MaterialCustodyIntent,type MaterialCustodyState,type MaterialCustodyValue,
  type MaterialGrant,type MaterialHold,type MaterialRange,type MaterialRecipient,type MaterialSearchRequest,type MaterialSearchPage,type MaterialVersion} from "@agent-anything/context/custody";
import type {ContextAcceptancePart} from "@agent-anything/context/selection";
import {SharedAcceptanceRejection,type SharedAcceptanceParticipant} from "./SharedAcceptanceDatabase.js";
import {ContextFoundationRecords,checkedJson,requireSame} from "./ContextFoundationRecords.js";

export const MATERIAL_CUSTODY_SCHEMA=`
CREATE TABLE material_custodies(sequence INTEGER PRIMARY KEY,id TEXT NOT NULL UNIQUE,instance_id TEXT NOT NULL UNIQUE,run_id TEXT NOT NULL,value TEXT NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL,bytes INTEGER NOT NULL,chunks INTEGER NOT NULL,cleanup_id TEXT,manifest TEXT,manifest_digest TEXT);
CREATE TABLE material_custody_chunks(instance_id TEXT NOT NULL,offset INTEGER NOT NULL,id TEXT NOT NULL UNIQUE,bytes BLOB NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(instance_id,offset));
CREATE TABLE material_versions(material_id TEXT NOT NULL,version TEXT NOT NULL,value TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(material_id,version));
CREATE TABLE material_holds(id TEXT PRIMARY KEY,instance_id TEXT NOT NULL,run_id TEXT NOT NULL,value TEXT NOT NULL,digest TEXT NOT NULL,released TEXT);
CREATE INDEX material_holds_live ON material_holds(instance_id,released);
CREATE TABLE material_grants(id TEXT PRIMARY KEY,instance_id TEXT NOT NULL,recipient_key TEXT NOT NULL,revision INTEGER NOT NULL,value TEXT NOT NULL,digest TEXT NOT NULL);
CREATE INDEX material_grants_recipient ON material_grants(recipient_key,instance_id);
`;
interface CustodyRow {id:string;instance_id:string;run_id:string;value:string;digest:string;state:MaterialCustodyState["state"];bytes:number;chunks:number;cleanup_id:string|null;manifest:string|null;manifest_digest:string|null;}
type MaterialPart=Extract<ContextAcceptancePart,{owner:"material_custody"}>;
const CHUNK_BYTES=262144;
const PAGE_BYTES=65536;
const SCAN_BYTES=1048576;

/** Only custody owns content availability. Representation and delivery own why it is retained. */
export class MaterialCustodyDatabase {
  constructor(private readonly db:Database.Database,private readonly records:ContextFoundationRecords,
    private readonly storageBudget=8*1024*1024*1024,private readonly mayRelease:(hold:MaterialHold)=>boolean=()=>true) {}

  command(command:MaterialCustodyCommand):MaterialCustodyValue {
    switch(command.kind) {
      case "begin": return this.begin(command.intent);
      case "append": return this.append(command);
      case "complete": return this.complete(command.intentId);
      case "state": return this.state(command.intentId);
      case "abandon": return this.abandon(command);
      case "describe": {
        const hold=this.hold(command.holdId);if(!hold)fail("material_unavailable");
        this.requireProtected(hold.instanceId,hold.range,command.recipient,hold.id);
        return {hold,version:this.instance(hold.instanceId)!.version!};
      }
      case "hold": this.db.transaction(()=>this.acquire(command.hold))();return this.instance(command.hold.instanceId);
      case "release": this.db.transaction(()=>this.release(command.holdId,command.basis))();return null;
      case "grant": this.db.transaction(()=>this.grant(command.grant,command.expectedRevision))();return null;
      case "read": return this.read(command.access,command.offset,command.length);
      case "read_structure": return this.readStructure(command);
      case "search": return this.search(command.request);
      case "discover": return this.discover(command);
      case "seal": return this.seal(command.instanceId,command.cleanupId);
      case "delete": return this.delete(command.instanceId,command.cleanupId,command.maximumChunks);
    }
  }
  participant():SharedAcceptanceParticipant {
    return {owner:"material_custody",kinds:["publish","holds"],prepare:(part,acceptance)=>{
      const value=part as MaterialPart;
      if (value.kind==="publish") {
        const state=this.requireIntent(value.proposal.intentId);
        if (state.intent.version.origin.runId!==acceptance.scope || state.intent.owner!==acceptance.actor) reject("material_publish_owner_invalid");
        if (!["complete","published"].includes(state.state)) reject("material_not_complete");
      }
      return structuredClone(value);
    },apply:value=>{
      try {
        const part=value as MaterialPart;
        if(part.kind==="publish") {
          const state=this.requireIntent(part.proposal.intentId);
          if(!["complete","published"].includes(state.state)) fail("material_not_complete");
          const version=state.version!;
          const previous=this.version(version.ref.materialId,version.ref.version);
          if(previous) requireSame(previous,version);
          else this.records.sql("INSERT INTO material_versions VALUES (?,?,?,?)").run(version.ref.materialId,version.ref.version,JSON.stringify(version),modelInputValueDigest(version));
          this.records.sql("UPDATE material_custodies SET state='published' WHERE id=?").run(state.intent.id);
          if(!part.proposal.holds.length) fail("material_publication_requires_consumer");
          for(const grant of part.proposal.grants) {
            if(grant.instanceId!==state.intent.instanceId) fail("material_publication_scope_invalid");
            this.grant(grant,null);
          }
          for(const hold of part.proposal.holds) {
            if(hold.instanceId!==state.intent.instanceId) fail("material_publication_scope_invalid");
            this.acquire(hold);
          }
          this.fact(state,"published",{holds:part.proposal.holds.map(h=>h.id)});
        } else {
          for(const hold of part.proposal.acquire) this.acquire(hold);
          for(const id of part.proposal.release) this.release(id,part.proposal.basis);
        }
      } catch(error) {if(error instanceof MaterialCustodyError) reject(error.code);throw error;}
    }};
  }
  requireProtected(instanceId:string,range:MaterialRange,recipient:MaterialRecipient,holdId?:string):void {
    const state=this.instance(instanceId);
    if(!state || state.state!=="published") fail("material_unavailable");
    this.range(state.version!,range);
    const rows=(holdId ? this.records.sql("SELECT value,digest FROM material_holds WHERE id=? AND instance_id=? AND released IS NULL").all(holdId,instanceId) :
      this.records.sql("SELECT value,digest FROM material_holds WHERE instance_id=? AND released IS NULL").all(instanceId)) as {value:string;digest:string}[];
    if(!rows.some(row=>{const hold=checkedJson<MaterialHold>(row);return recipientKey(hold.consumer)===recipientKey(recipient)&&containsMaterialRange(hold.range,range);})) fail("material_hold_missing");
    this.authorized(instanceId,range,recipient);
  }
  hold(id:string):MaterialHold|null {
    const row=this.records.sql("SELECT value,digest FROM material_holds WHERE id=? AND released IS NULL").get(id) as {value:string;digest:string}|undefined;
    return row ? checkedJson<MaterialHold>(row) : null;
  }
  version(materialId:string,version:string):MaterialVersion|null {
    const row=this.records.sql("SELECT value,digest FROM material_versions WHERE material_id=? AND version=?").get(materialId,version) as {value:string;digest:string}|undefined;
    return row ? checkedJson<MaterialVersion>(row) : null;
  }
  retainedRuns():readonly string[] {
    return (this.records.sql("SELECT DISTINCT run_id FROM material_holds WHERE released IS NULL UNION SELECT run_id FROM material_custodies WHERE state IN ('staging','complete','sealed')").all() as {run_id:string}[]).map(r=>r.run_id);
  }
  instance(id:string):MaterialCustodyState|null {
    const row=this.records.sql("SELECT * FROM material_custodies WHERE instance_id=?").get(id) as CustodyRow|undefined;
    return row ? this.fromRow(row):null;
  }
  private state(id:string):MaterialCustodyState|null {
    const row=this.records.sql("SELECT * FROM material_custodies WHERE id=?").get(id) as CustodyRow|undefined;
    return row ? this.fromRow(row):null;
  }
  private fromRow(row:CustodyRow):MaterialCustodyState {
    const intent=checkedJson<MaterialCustodyIntent>(row);
    if(intent.id!==row.id || intent.instanceId!==row.instance_id || intent.version.origin.runId!==row.run_id) fail("material_custody_corrupt");
    const version=row.manifest&&row.manifest_digest?checkedJson<MaterialVersion>({value:row.manifest,digest:row.manifest_digest}):null;
    if(["complete","published"].includes(row.state)&&!version)fail("material_manifest_missing");
    return {intent,state:row.state,bytes:row.bytes,chunks:row.chunks,cleanupId:row.cleanup_id,version};
  }
  private requireIntent(id:string):MaterialCustodyState {const state=this.state(id);if(!state) fail("material_intent_missing");return state;}
  private begin(intent:MaterialCustodyIntent):MaterialCustodyState {
    const v=intent.version;
    [intent.id,intent.instanceId,intent.activityId,intent.owner,v.ref.materialId,v.ref.version,v.origin.runId,v.origin.owner,v.origin.recordId,v.origin.revision,v.label,v.mediaType].forEach(custodyToken);
    if(!Number.isFinite(Date.parse(v.origin.occurredAt)))fail("material_origin_time_invalid");
    if(v.bytes!==null)custodyCount(v.bytes);custodyCount(intent.maximumBytes,this.storageBudget);
    if(v.bytes!==null&&v.bytes>intent.maximumBytes || v.digest!==null&&!/^sha256:[0-9a-f]{64}$/.test(v.digest) || !["utf8","json","opaque","locator"].includes(v.format) || !["complete","prefix","incomplete"].includes(v.capture)) fail("material_manifest_invalid");
    return this.db.transaction(()=>{
      const old=this.state(intent.id);if(old){requireSame(old.intent,intent);return old;}
      const reserved=this.records.sql("SELECT COALESCE(SUM(json_extract(value,'$.maximumBytes')),0) AS bytes FROM material_custodies WHERE state<>'deleted'").get() as {bytes:number};
      if(reserved.bytes+intent.maximumBytes>this.storageBudget) fail("material_storage_budget");
      this.records.sql("INSERT INTO material_custodies(id,instance_id,run_id,value,digest,state,bytes,chunks,cleanup_id) VALUES (?,?,?,?,?,'staging',0,0,NULL)")
        .run(intent.id,intent.instanceId,v.origin.runId,JSON.stringify(intent),modelInputValueDigest(intent));
      const state=this.requireIntent(intent.id);this.fact(state,"custody_started",{activityId:intent.activityId,maximumBytes:intent.maximumBytes});return state;
    })();
  }
  private append(command:Extract<MaterialCustodyCommand,{kind:"append"}>):MaterialCustodyState {
    custodyToken(command.id);custodyCount(command.offset);
    if(typeof command.bytesBase64!=="string" || command.bytesBase64.length>Math.ceil(CHUNK_BYTES/3)*4)fail("material_chunk_bound_invalid");
    const bytes=Buffer.from(command.bytesBase64,"base64"),digest=byteDigest(bytes);
    if(bytes.toString("base64")!==command.bytesBase64)fail("material_chunk_encoding_invalid");
    custodyCount(bytes.byteLength,CHUNK_BYTES);
    if(!bytes.length) fail("material_empty_chunk");
    return this.db.transaction(()=>{
      const state=this.requireIntent(command.intentId);
      const prior=this.records.sql("SELECT instance_id,offset,digest FROM material_custody_chunks WHERE id=?").get(command.id) as {instance_id:string;offset:number;digest:string}|undefined;
      if(prior){requireSame(prior,{instance_id:state.intent.instanceId,offset:command.offset,digest});return state;}
      if(state.state!=="staging" || state.bytes!==command.offset || state.bytes+bytes.length>state.intent.maximumBytes || state.intent.version.bytes!==null&&state.bytes+bytes.length>state.intent.version.bytes) fail("material_write_bound_invalid");
      this.records.sql("INSERT INTO material_custody_chunks VALUES (?,?,?,?,?)").run(state.intent.instanceId,command.offset,command.id,bytes,digest);
      this.records.sql("UPDATE material_custodies SET bytes=bytes+?,chunks=chunks+1 WHERE id=?").run(bytes.length,state.intent.id);
      return this.requireIntent(state.intent.id);
    })();
  }
  private complete(id:string):MaterialCustodyState {
    const state=this.requireIntent(id);
    if(state.state!=="staging") {if(["complete","published"].includes(state.state))return state;fail("material_not_staging");}
    if(state.intent.version.bytes!==null&&state.bytes!==state.intent.version.bytes) fail("material_content_incomplete");
    const hash=createHash("sha256");let offset=0,count=0;
    // The Worker owns mutation; no transaction remains open while content is checked.
    for(const row of this.records.sql("SELECT offset,bytes,digest FROM material_custody_chunks WHERE instance_id=? ORDER BY offset").iterate(state.intent.instanceId) as Iterable<{offset:number;bytes:Buffer;digest:string}>) {
      if(row.offset!==offset || byteDigest(row.bytes)!==row.digest) fail("material_content_corrupt");
      hash.update(row.bytes);offset+=row.bytes.length;count++;
    }
    const digest=`sha256:${hash.digest("hex")}`;
    if(offset!==state.bytes || count!==state.chunks || state.intent.version.digest!==null&&digest!==state.intent.version.digest) fail("material_content_corrupt");
    const manifest:MaterialVersion={...state.intent.version,bytes:offset,digest};
    return this.db.transaction(()=>{
      const current=this.requireIntent(id);requireSame(current,state);
      this.records.sql("UPDATE material_custodies SET state='complete',manifest=?,manifest_digest=? WHERE id=?").run(JSON.stringify(manifest),modelInputValueDigest(manifest),id);
      this.fact(state,"content_completed",{bytes:offset,chunks:count});return this.requireIntent(id);
    })();
  }
  private acquire(hold:MaterialHold):void {
    [hold.id,hold.basis,hold.releaseCondition,hold.consumer.runId,hold.consumer.recipient,hold.consumer.purpose].forEach(custodyToken);
    const old=this.records.sql("SELECT value,digest,released FROM material_holds WHERE id=?").get(hold.id) as {value:string;digest:string;released:string|null}|undefined;
    if(old){requireSame(checkedJson(old),hold);if(old.released)fail("material_hold_retired");return;}
    const state=this.instance(hold.instanceId);if(!state || state.state!=="published")fail("material_unavailable");
    this.range(state.version!,hold.range);this.authorized(hold.instanceId,hold.range,hold.consumer);
    this.records.sql("INSERT INTO material_holds VALUES (?,?,?,?,?,NULL)").run(hold.id,hold.instanceId,hold.consumer.runId,JSON.stringify(hold),modelInputValueDigest(hold));
    this.records.fact(hold.consumer.runId,"material_custody",hold.id,"hold_acquired",{instanceId:hold.instanceId,responsibility:hold.responsibility,range:hold.range,basis:hold.basis});
  }
  private release(id:string,basis:string):void {
    custodyToken(basis);
    const old=this.records.sql("SELECT value,digest,released FROM material_holds WHERE id=?").get(id) as {value:string;digest:string;released:string|null}|undefined;
    if(!old)fail("material_hold_missing");
    if(old.released){if(old.released!==basis)fail("material_release_conflict");return;}
    const hold=checkedJson<MaterialHold>(old);
    if(!this.mayRelease(hold))fail("material_consumer_still_active");
    this.records.sql("UPDATE material_holds SET released=? WHERE id=?").run(basis,id);
    this.records.fact(hold.consumer.runId,"material_custody",id,"hold_released",{basis,instanceId:hold.instanceId});
  }
  private grant(grant:MaterialGrant,expected:number|null):void {
    [grant.id,grant.basis,grant.recipient.runId,grant.recipient.recipient,grant.recipient.purpose].forEach(custodyToken);custodyCount(grant.revision);
    const state=this.instance(grant.instanceId);if(!state?.version)fail("material_unavailable");this.range(state.version,grant.range);
    const old=this.records.sql("SELECT value,digest,revision FROM material_grants WHERE id=?").get(grant.id) as {value:string;digest:string;revision:number}|undefined;
    if(old && old.revision===grant.revision){requireSame(checkedJson(old),grant);return;}
    if((old?.revision??null)!==expected || grant.revision!==(expected===null?0:expected+1))fail("material_grant_conflict");
    if(old){const previous=checkedJson<MaterialGrant>(old);if(previous.instanceId!==grant.instanceId || recipientKey(previous.recipient)!==recipientKey(grant.recipient))fail("material_grant_identity_invalid");}
    this.records.sql("INSERT INTO material_grants VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,value=excluded.value,digest=excluded.digest")
      .run(grant.id,grant.instanceId,recipientKey(grant.recipient),grant.revision,JSON.stringify(grant),modelInputValueDigest(grant));
  }
  private authorized(instanceId:string,range:MaterialRange,recipient:MaterialRecipient):void {
    const rows=this.records.sql("SELECT value,digest FROM material_grants WHERE instance_id=? AND recipient_key=?").all(instanceId,recipientKey(recipient)) as {value:string;digest:string}[];
    if(!rows.some(row=>{const grant=checkedJson<MaterialGrant>(row);return grant.allowed&&containsMaterialRange(grant.range,range);}))fail("material_unavailable");
  }
  private range(version:MaterialVersion,range:MaterialRange):void {
    custodyCount(range.start);custodyCount(range.end,version.bytes);
    if(range.coordinate!=="bytes" || range.start>range.end || !sameMaterialVersion(version.ref,range))fail("material_range_invalid");
  }
  private access(access:MaterialAccess):MaterialCustodyState {
    custodyToken(access.id);const hold=this.hold(access.holdId);if(!hold)fail("material_unavailable");
    this.requireProtected(hold.instanceId,access.range,access.recipient,hold.id);
    return this.instance(hold.instanceId)!;
  }
  private bytes(instanceId:string,start:number,end:number):Buffer {
    const output:Buffer[]=[];let position=start;
    for(const row of this.records.sql("SELECT offset,bytes,digest FROM material_custody_chunks WHERE instance_id=? AND offset<? AND offset+length(bytes)>? ORDER BY offset").iterate(instanceId,end,start) as Iterable<{offset:number;bytes:Buffer;digest:string}>) {
      if(byteDigest(row.bytes)!==row.digest || row.offset>position)fail("material_content_corrupt");
      const piece=row.bytes.subarray(Math.max(0,position-row.offset),Math.min(row.bytes.length,end-row.offset));
      output.push(piece);position+=piece.length;
    }
    if(position!==end)fail("material_content_corrupt");return Buffer.concat(output,end-start);
  }
  private read(access:MaterialAccess,offset:number,length:number):MaterialCustodyValue {
    const state=this.access(access),version=state.version!;
    custodyCount(offset);custodyCount(length,PAGE_BYTES);
    if(length<4 || offset<access.range.start || offset>access.range.end)fail("material_read_bound_invalid");
    let end=Math.min(access.range.end,offset+length);
    const bytes=this.bytes(state.intent.instanceId,offset,Math.min(access.range.end,end+3));
    const textual=version.format==="utf8" || version.format==="json" || version.format==="locator";
    if(textual && bytes.length && (bytes[0]!&0xc0)===0x80)fail("material_utf8_boundary_invalid");
    if(textual && end<access.range.end)while(end>offset && (bytes[end-offset]!&0xc0)===0x80)end--;
    const page=bytes.subarray(0,end-offset);
    let text:string|null=null;
    if(textual){try{text=new TextDecoder("utf-8",{fatal:true}).decode(page);}catch{fail("material_encoding_invalid");}}
    this.records.fact(access.recipient.runId,"material_custody",access.id,"read",{instanceId:state.intent.instanceId,start:offset,end,purpose:access.recipient.purpose});
    return {version,instanceId:state.intent.instanceId,start:offset,end,bytesBase64:page.toString("base64"),text,next:end<access.range.end?end:null};
  }
  private search(request:MaterialSearchRequest):MaterialSearchPage {
    const state=this.access(request);
    if(!["utf8","json","locator"].includes(state.version!.format))fail("material_search_unsupported");
    if(!["sensitive","ascii_insensitive"].includes(request.caseMode))fail("material_search_mode_unsupported");
    const needle=Buffer.from(request.query,"utf8");
    if(!needle.length || needle.length>4096)fail("material_search_query_invalid");
    custodyCount(request.maximumMatches,64);custodyCount(request.scanBytes,SCAN_BYTES);
    if(request.maximumMatches<1 || request.scanBytes<needle.length)fail("material_search_bound_invalid");
    const binding=modelInputValueDigest({instanceId:state.intent.instanceId,range:request.range,query:request.query,caseMode:request.caseMode,recipient:request.recipient,holdId:request.holdId});
    let position=request.range.start;
    if(request.cursor) {
      let cursor:{binding:string;position:number};try{cursor=JSON.parse(Buffer.from(request.cursor,"base64url").toString("utf8"));}catch{fail("material_search_cursor_invalid");}
      if(cursor.binding!==binding || !Number.isSafeInteger(cursor.position) || cursor.position<position || cursor.position>request.range.end)fail("material_search_cursor_invalid");position=cursor.position;
    }
    const start=position,end=Math.min(request.range.end,start+request.scanBytes);
    const bytes=this.bytes(state.intent.instanceId,start,Math.min(request.range.end,end+needle.length-1));
    const haystack=request.caseMode==="ascii_insensitive"?asciiFold(bytes):bytes;
    const query=request.caseMode==="ascii_insensitive"?asciiFold(needle):needle;
    const matches:{start:number;end:number;text:string}[]=[];
    let stop:MaterialSearchPage["stop"]="scan_budget";
    while(position<end) {
      const found=haystack.indexOf(query,position-start);
      if(found<0 || start+found>=end){position=end;break;}
      const matchStart=start+found,matchEnd=matchStart+needle.length;
      if(matchEnd>request.range.end){position=end;break;}
      matches.push({start:matchStart,end:matchEnd,text:bytes.subarray(found,found+needle.length).toString("utf8")});
      position=matchStart+1;
      if(matches.length===request.maximumMatches){stop="match_limit";break;}
    }
    const complete=position>=request.range.end;
    if(complete)stop="range_end";
    const result={version:state.version!.ref,matches,scanned:{start,end:position},complete,
      next:complete?null:Buffer.from(JSON.stringify({binding,position})).toString("base64url"),stop};
    this.records.fact(request.recipient.runId,"material_custody",request.id,"search",{instanceId:state.intent.instanceId,range:request.range,query:request.query,caseMode:request.caseMode,scanned:result.scanned,complete,stop,matches:matches.length});
    return result;
  }
  private readStructure(command:Extract<MaterialCustodyCommand,{kind:"read_structure"}>):MaterialCustodyValue {
    const state=this.access(command.access),version=state.version!;
    if(version.format!=="json")fail("material_structure_unsupported");
    custodyCount(command.maximumSourceBytes,SCAN_BYTES);custodyCount(command.maximumResultBytes,PAGE_BYTES);
    if(!Array.isArray(command.path)||command.path.length>64||command.path.some(part=>typeof part!=="string"||part.length>2048))fail("material_structure_path_invalid");
    if(command.access.range.start!==0||command.access.range.end!==version.bytes)fail("material_structure_requires_complete_range");
    if(version.bytes>command.maximumSourceBytes)fail("material_structure_source_budget");
    let value:unknown;
    try{value=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(this.bytes(state.intent.instanceId,0,version.bytes)));}
    catch{fail("material_structure_invalid");}
    for(const part of command.path){
      if(value===null||typeof value!=="object"||!Object.hasOwn(value,part)||(Array.isArray(value)&&!/^(0|[1-9][0-9]*)$/.test(part)))fail("material_structure_path_missing");
      value=(value as Record<string,unknown>)[part];
    }
    if(Buffer.byteLength(JSON.stringify(value))>command.maximumResultBytes)fail("material_structure_result_budget");
    this.records.fact(command.access.recipient.runId,"material_custody",command.access.id,"structure_read",{instanceId:state.intent.instanceId,path:command.path,sourceRange:command.access.range});
    return {version,instanceId:state.intent.instanceId,path:command.path,value,sourceRange:command.access.range,coordinate:"json_path",complete:true};
  }
  private discover(command:Extract<MaterialCustodyCommand,{kind:"discover"}>):MaterialCustodyValue {
    custodyCount(command.after);custodyCount(command.limit,64);if(!command.limit)fail("material_page_invalid");
    const filter=command.filter??{};
    for(const value of Object.values(filter))if(typeof value!=="string"||value.length>2048)fail("material_discovery_filter_invalid");
    for(const value of [filter.occurredFrom,filter.occurredBefore])if(value!==undefined&&!Number.isFinite(Date.parse(value)))fail("material_discovery_filter_invalid");
    const frontier=command.frontier??(this.records.sql("SELECT COALESCE(MAX(sequence),0) AS n FROM material_custodies").get() as {n:number}).n;
    custodyCount(frontier);
    const rows=this.records.sql("SELECT DISTINCT c.* FROM material_custodies c JOIN material_grants g ON g.instance_id=c.instance_id WHERE c.state='published' AND g.recipient_key=? AND c.sequence>? AND c.sequence<=? ORDER BY c.sequence LIMIT 128")
      .iterate(recipientKey(command.recipient),command.after,frontier) as Iterable<CustodyRow&{sequence:number}>;
    const values:{sequence:number;instanceId:string;version:MaterialVersion;hold:MaterialHold}[]=[];let scanned=command.after,examined=0;
    for(const row of rows){
      scanned=row.sequence;examined++;const state=this.fromRow(row),v=state.version!;
      const holds=this.records.sql("SELECT value,digest FROM material_holds WHERE instance_id=? AND released IS NULL").all(state.intent.instanceId) as {value:string;digest:string}[];
      const hold=holds.map(row=>checkedJson<MaterialHold>(row)).find(h=>{
        if(recipientKey(h.consumer)!==recipientKey(command.recipient))return false;
        try{this.authorized(state.intent.instanceId,h.range,command.recipient);return true;}
        catch(error){if(error instanceof MaterialCustodyError&&error.code==="material_unavailable")return false;throw error;}
      });
      if(!hold)continue;
      if(filter.sourceRunId!==undefined&&v.origin.runId!==filter.sourceRunId||filter.sourceOwner!==undefined&&v.origin.owner!==filter.sourceOwner||
        filter.sourceRecordId!==undefined&&v.origin.recordId!==filter.sourceRecordId||filter.activityId!==undefined&&state.intent.activityId!==filter.activityId||
        filter.materialId!==undefined&&v.ref.materialId!==filter.materialId||filter.format!==undefined&&v.format!==filter.format||
        filter.occurredFrom!==undefined&&Date.parse(v.origin.occurredAt)<Date.parse(filter.occurredFrom)||
        filter.occurredBefore!==undefined&&Date.parse(v.origin.occurredAt)>=Date.parse(filter.occurredBefore)||
        filter.labelIncludes!==undefined&&!v.label.includes(filter.labelIncludes))continue;
      values.push({sequence:row.sequence,instanceId:state.intent.instanceId,version:v,hold});if(values.length===command.limit)break;
    }
    return {values,frontier,next:scanned<frontier && (examined===128 || values.length===command.limit)?scanned:null};
  }
  private abandon(command:Extract<MaterialCustodyCommand,{kind:"abandon"}>):MaterialCustodyState {
    custodyToken(command.basis);custodyToken(command.cleanupId);
    return this.db.transaction(()=>{
      const state=this.requireIntent(command.intentId);
      if(state.intent.owner!==command.owner)fail("material_owner_invalid");
      if(state.cleanupId===command.cleanupId)return state;
      if(!["staging","complete"].includes(state.state))fail("material_not_staging");
      this.records.sql("UPDATE material_custodies SET state='sealed',cleanup_id=? WHERE id=?").run(command.cleanupId,command.intentId);
      this.fact(state,"custody_abandoned",{basis:command.basis,cleanupId:command.cleanupId,bytes:state.bytes});
      return this.requireIntent(command.intentId);
    })();
  }
  private seal(instanceId:string,cleanupId:string):MaterialCustodyState {
    custodyToken(cleanupId);
    return this.db.transaction(()=>{
      const state=this.instance(instanceId);if(!state)fail("material_unavailable");
      if(state.cleanupId){if(state.cleanupId!==cleanupId)fail("material_cleanup_conflict");return state;}
      if(state.state!=="published" || this.records.sql("SELECT 1 FROM material_holds WHERE instance_id=? AND released IS NULL LIMIT 1").get(instanceId))fail("material_retained");
      this.records.sql("UPDATE material_custodies SET state='sealed',cleanup_id=? WHERE instance_id=?").run(cleanupId,instanceId);
      this.fact(state,"cleanup_sealed",{cleanupId});return this.instance(instanceId)!;
    })();
  }
  private delete(instanceId:string,cleanupId:string,maximumChunks:number):MaterialCustodyState {
    custodyCount(maximumChunks,64);if(!maximumChunks)fail("material_delete_bound_invalid");
    return this.db.transaction(()=>{
      const state=this.instance(instanceId);if(!state || state.cleanupId!==cleanupId || !["sealed","deleted"].includes(state.state))fail("material_cleanup_conflict");
      if(state.state==="deleted")return state;
      this.records.sql("DELETE FROM material_custody_chunks WHERE id IN (SELECT id FROM material_custody_chunks WHERE instance_id=? ORDER BY offset LIMIT ?)").run(instanceId,maximumChunks);
      if(!this.records.sql("SELECT 1 FROM material_custody_chunks WHERE instance_id=? LIMIT 1").get(instanceId)) {
        this.records.sql("UPDATE material_custodies SET state='deleted' WHERE instance_id=?").run(instanceId);this.fact(state,"content_deleted",{cleanupId});
      }
      return this.instance(instanceId)!;
    })();
  }
  private fact(state:MaterialCustodyState,kind:string,details:Readonly<Record<string,unknown>>):void {
    this.records.fact(state.intent.version.origin.runId,"material_custody",state.intent.instanceId,kind,{version:state.intent.version.ref,...details});
  }
}
function recipientKey(recipient:MaterialRecipient):string{return JSON.stringify([recipient.runId,recipient.recipient,recipient.purpose]);}
function byteDigest(bytes:Uint8Array):string{return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;}
function asciiFold(bytes:Buffer):Buffer{return Buffer.from(bytes.map(value=>value>=65&&value<=90?value+32:value));}
function fail(code:string):never{throw new MaterialCustodyError(code);}
function reject(code:string):never{throw new SharedAcceptanceRejection("material_custody",code);}

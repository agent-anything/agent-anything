import {createHash} from "node:crypto";
import {CONTEXT_MATERIAL_LIMITS as LIMITS,ContextMaterialError,snapshotContextMaterialRef,snapshotContextMaterialRefs,
  type ContextMaterialAccessPort,type ContextMaterialDescription,type ContextMaterialRef,type ContextMaterialSearch,type ContextMaterialSearchPage} from "../material/ContextMaterial.js";
import {type MaterialAccessDescription,type MaterialCustodyPort,type MaterialDiscoveryPage,type MaterialRecipient,type MaterialReadPage,type MaterialSearchPage} from "./MaterialCustody.js";

interface Cursor {
  binding:string;frontier:number|null;after:number;index:number;current:ContextMaterialRef|null;scan:string|null;discoveryDone:boolean;
}
const PREFIX="custody:";

/** Public tools and professional readers share custody; neither a reference nor a cursor grants access. */
export class CustodyMaterialAccess implements ContextMaterialAccessPort {
  constructor(private readonly custody:MaterialCustodyPort,private readonly recipient:MaterialRecipient) {}
  reference(description:MaterialAccessDescription):ContextMaterialRef {
    return snapshotContextMaterialRef({id:PREFIX+Buffer.from(description.hold.id).toString("base64url"),revision:description.version.digest});
  }
  async validate(runId:string,references:readonly ContextMaterialRef[]):Promise<void> {
    this.run(runId);
    for(const reference of snapshotContextMaterialRefs(references))await this.describe(reference);
  }
  async read(runId:string,input:Parameters<ContextMaterialAccessPort["read"]>[1],signal:AbortSignal,invocationId:string) {
    this.run(runId);signal.throwIfAborted();
    const description=await this.describe(input.reference),offset=input.offset??0,length=input.length??LIMITS.pageBytes;
    if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(length)||length<4||length>LIMITS.pageBytes)fail("context_range_invalid");
    signal.throwIfAborted();
    const page=await this.call({kind:"read",access:{id:invocationId,holdId:description.hold.id,recipient:this.recipient,range:description.hold.range},
      offset:description.hold.range.start+offset,length}) as MaterialReadPage;
    if(page.text===null)fail("context_material_format_unsupported");
    const start=page.start-description.hold.range.start,end=page.end-description.hold.range.start;
    return {description:this.description(description),text:page.text,byteStart:start,byteEnd:end,nextOffset:page.next===null?null:page.next-description.hold.range.start,
      complete:start===0&&page.next===null,coordinate:"utf8_view_bytes" as const};
  }
  async search(runId:string,input:ContextMaterialSearch,signal:AbortSignal,invocationId:string,deadlineAt?:string):Promise<ContextMaterialSearchPage> {
    this.run(runId);signal.throwIfAborted();
    const limit=input.limit??8,query=input.query??"",mode=input.in??"content";
    if(!Number.isSafeInteger(limit)||limit<1||limit>LIMITS.matches||typeof query!=="string"||Buffer.byteLength(query)>LIMITS.queryBytes||!["content","description"].includes(mode))fail("context_search_invalid");
    const references=input.references?snapshotContextMaterialRefs(input.references):null;
    if(references&&!references.length)fail("context_references_invalid");
    const binding=digest({recipient:this.recipient,query,mode,references});
    const cursor:Cursor=input.cursor?decode(input.cursor):{binding,frontier:null,after:0,index:0,current:null,scan:null,discoveryDone:false};
    if(cursor.binding!==binding||!Number.isSafeInteger(cursor.after)||cursor.after<0||!Number.isSafeInteger(cursor.index)||cursor.index<0||
      (cursor.frontier!==null&&(!Number.isSafeInteger(cursor.frontier)||cursor.frontier<cursor.after))||typeof cursor.discoveryDone!=="boolean")fail("context_cursor_invalid");
    const matches:ContextMaterialSearchPage["matches"][number][]=[];
    let scannedBytes=0,scannedDescriptions=0,iterations=0;
    const deadline=Math.min(Date.now()+LIMITS.searchMs,deadlineAt?Date.parse(deadlineAt):Infinity);
    if(Number.isNaN(deadline))fail("context_deadline_invalid");
    while(matches.length<limit&&scannedBytes<LIMITS.searchBytes&&scannedDescriptions<LIMITS.descriptions&&iterations<128&&Date.now()<deadline) {
      signal.throwIfAborted();iterations++;
      if(!cursor.current) {
        if(references) {
          if(cursor.index>=references.length)break;
          cursor.current=references[cursor.index]!;
        } else {
          if(cursor.discoveryDone)break;
          const page=await this.call({kind:"discover",recipient:this.recipient,after:cursor.after,frontier:cursor.frontier,limit:1}) as MaterialDiscoveryPage;
          cursor.frontier=page.frontier;cursor.after=page.next??page.frontier;cursor.discoveryDone=page.next===null;
          if(!page.values.length)continue;
          cursor.current=this.reference(page.values[0]!);
        }
      }
      const material=await this.describe(cursor.current),description=this.description(material);scannedDescriptions++;
      if(!query||mode==="description") {
        if(!query||description.label.includes(query))matches.push({description,excerpt:description.label,byteStart:0,byteEnd:0});
        cursor.current=null;cursor.scan=null;cursor.index++;continue;
      }
      const page=await this.call({kind:"search",request:{id:`${invocationId}:${iterations}`,holdId:material.hold.id,recipient:this.recipient,range:material.hold.range,
        query,caseMode:"sensitive",maximumMatches:limit-matches.length,scanBytes:Math.min(LIMITS.scanBytes,LIMITS.searchBytes-scannedBytes),...(cursor.scan?{cursor:cursor.scan}:{})}}) as MaterialSearchPage;
      scannedBytes+=page.scanned.end-page.scanned.start;
      matches.push(...page.matches.map(match=>({description,excerpt:match.text,byteStart:match.start-material.hold.range.start,byteEnd:match.end-material.hold.range.start})));
      cursor.scan=page.next;
      if(page.complete){cursor.current=null;cursor.index++;}
    }
    signal.throwIfAborted();
    const exhausted=cursor.current===null&&(references?cursor.index>=references.length:cursor.discoveryDone);
    const nextCursor=exhausted?null:Buffer.from(JSON.stringify(cursor)).toString("base64url");
    if(nextCursor&&nextCursor.length>4096)fail("context_cursor_bound_exceeded");
    return {matches,nextCursor,exhausted,scannedBytes,scannedDescriptions,frontier:cursor.frontier??references?.length??0,
      limitations:[],stopReason:exhausted?"scope_exhausted":matches.length===limit?"result_limit":"execution_budget"};
  }
  private run(runId:string):void {if(runId!==this.recipient.runId)fail("context_material_unavailable");}
  private async describe(reference:ContextMaterialRef):Promise<MaterialAccessDescription> {
    const ref=snapshotContextMaterialRef(reference);
    if(!ref.id.startsWith(PREFIX))fail("context_reference_invalid");
    const holdId=Buffer.from(ref.id.slice(PREFIX.length),"base64url").toString("utf8");
    const description=await this.call({kind:"describe",holdId,recipient:this.recipient}) as MaterialAccessDescription;
    if(this.reference(description).id!==ref.id||description.version.digest!==ref.revision)fail("context_material_unavailable");
    if(description.version.format==="opaque")fail("context_material_format_unsupported");
    return description;
  }
  private description(value:MaterialAccessDescription):ContextMaterialDescription {
    const {version,hold}=value;
    return {reference:this.reference(value),originRunId:version.origin.runId,source:{owner:version.origin.owner,kind:"retained_material",id:version.origin.recordId,revision:version.origin.revision},
      label:version.label,role:"data",position:0,bytes:hold.range.end-hold.range.start,format:version.format==="json"?"json":"text",
      relationships:[{kind:"material_version",id:version.ref.materialId},{kind:"custody_instance",id:hold.instanceId}],limitations:version.limitations};
  }
  private async call(command:Parameters<MaterialCustodyPort["command"]>[0]) {
    try{return await this.custody.command(command);}catch(error){
      if(error instanceof Error&&"code" in error&&typeof error.code==="string"&&error.code.startsWith("material_"))throw new ContextMaterialError(error.code,error.message);
      throw error;
    }
  }
}
function digest(value:unknown):string{return createHash("sha256").update(JSON.stringify(value)).digest("hex");}
function decode(value:string):Cursor {
  if(value.length>4096)fail("context_cursor_invalid");
  try{const parsed:unknown=JSON.parse(Buffer.from(value,"base64url").toString("utf8"));if(!parsed||typeof parsed!=="object")fail("context_cursor_invalid");return parsed as Cursor;}
  catch{fail("context_cursor_invalid");}
}
function fail(code:string):never{throw new ContextMaterialError(code,code);}

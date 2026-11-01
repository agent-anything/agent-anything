import {CustodyMaterialAccess,type MaterialRecipient} from "@agent-anything/context/custody";
import {CONTEXT_MATERIAL_LIMITS as LIMITS,ContextMaterialError,contextMaterialDigest,snapshotContextMaterialRef,snapshotContextMaterialRefs,
  type ContextMaterialAccessPort,type ContextMaterialSearchPage} from "@agent-anything/context/material";
import {HELARC_CONTROLLER_CAPABILITY} from "@agent-anything/helarc/controller";
import type {HelarcExecutionStore} from "../execution-storage/HelarcExecutionStore.js";
import type {MaterialSearchScopes} from "../execution-storage/ContextMaterialDatabase.js";

type Store=Pick<HelarcExecutionStore,"contextMaterials"|"materialCustody"|"materialSearchScopes"|"readLatestRun">;
interface Cursor {binding:string;scopes:MaterialSearchScopes;source:number;cursor:string|null;}
const sources=["legacy","custody"] as const;

export async function helarcMaterialRecipient(store:Pick<Store,"readLatestRun">,runId:string):Promise<MaterialRecipient> {
  const head=await store.readLatestRun(runId);
  if(!head||head.state.run.id!==runId)fail("context_recipient_unavailable");
  return {runId,recipient:head.state.activeAgent.id,purpose:HELARC_CONTROLLER_CAPABILITY};
}

/** Routes explicit material identities, not failed access attempts; each source retains its authority. */
export function createHelarcMaterialAccess(store:Store):ContextMaterialAccessPort {
  const managed=async(runId:string)=>new CustodyMaterialAccess(store.materialCustody,await helarcMaterialRecipient(store,runId));
  return {
    read:async(runId,input,signal,id)=>{
      const reference=snapshotContextMaterialRef(input.reference);
      const owner=reference.id.startsWith("custody:")?await managed(runId):store.contextMaterials;
      return owner.read(runId,input,signal,id);
    },
    validate:async(runId,refs)=>{
      const references=snapshotContextMaterialRefs(refs);
      const custody=references.filter(ref=>ref.id.startsWith("custody:")),legacy=references.filter(ref=>!ref.id.startsWith("custody:"));
      if(custody.length)await (await managed(runId)).validate(runId,custody);
      if(legacy.length)await store.contextMaterials.validate(runId,legacy);
    },
    search:async(runId,input,signal,invocationId,deadlineAt)=>{
      signal.throwIfAborted();
      const limit=input.limit??8,query=input.query??"",mode=input.in??"content";
      if(input.bounds||!Number.isSafeInteger(limit)||limit<1||limit>LIMITS.matches||typeof query!=="string"||Buffer.byteLength(query)>LIMITS.queryBytes||!["content","description"].includes(mode))fail("context_search_invalid");
      const references=input.references?snapshotContextMaterialRefs(input.references):null;
      if(references&&!references.length)fail("context_references_invalid");
      const recipient=await helarcMaterialRecipient(store,runId),binding=contextMaterialDigest(JSON.stringify({recipient,query,mode,references}));
      const cursor:Cursor=input.cursor?decode(input.cursor):{binding,scopes:await store.materialSearchScopes(runId),source:0,cursor:null};
      if(cursor.binding!==binding||!Number.isSafeInteger(cursor.source)||cursor.source<0||cursor.source>2||
        cursor.cursor!==null&&typeof cursor.cursor!=="string"||!cursor.scopes||sources.some(s=>!Number.isSafeInteger(cursor.scopes[s])||cursor.scopes[s]<0))fail("context_cursor_invalid");
      const deadline=Math.min(Date.now()+LIMITS.searchMs,deadlineAt?Date.parse(deadlineAt):Infinity);
      if(!Number.isFinite(deadline))fail("context_deadline_invalid");
      const matches:ContextMaterialSearchPage["matches"][number][]=[],limitations=new Set<string>();
      let bytes=0,descriptions=0;
      while(cursor.source<2&&matches.length<limit&&bytes<LIMITS.searchBytes&&descriptions<LIMITS.descriptions&&Date.now()<deadline) {
        signal.throwIfAborted();const source=sources[cursor.source]!;
        const refs=references?.filter(ref=>ref.id.startsWith("custody:")===(source==="custody"));
        if(refs&&!refs.length){cursor.source++;cursor.cursor=null;continue;}
        const port=source==="custody"?new CustodyMaterialAccess(store.materialCustody,recipient):store.contextMaterials;
        const page=await port.search(runId,{query,in:mode,limit:limit-matches.length,...(refs?{references:refs}:{}),
          ...(cursor.cursor?{cursor:cursor.cursor}:{}),bounds:{frontier:cursor.scopes[source],bytes:LIMITS.searchBytes-bytes,descriptions:LIMITS.descriptions-descriptions}},
          signal,`${invocationId}:${source}`,new Date(deadline).toISOString());
        matches.push(...page.matches);bytes+=page.scannedBytes;descriptions+=page.scannedDescriptions;
        for(const limitation of page.limitations)limitations.add(limitation);
        cursor.cursor=page.nextCursor;
        if(!page.exhausted)break;
        cursor.source++;cursor.cursor=null;
      }
      signal.throwIfAborted();const exhausted=cursor.source===2;
      const nextCursor=exhausted?null:Buffer.from(JSON.stringify(cursor)).toString("base64url");
      if(nextCursor&&nextCursor.length>4096)fail("context_cursor_bound_exceeded");
      if(!exhausted){limitations.add("partial_scan");limitations.add("no_match_is_not_absence");}
      return {matches,nextCursor,exhausted,scannedBytes:bytes,scannedDescriptions:descriptions,
        frontier:{sources:sources.map(id=>({id,frontier:cursor.scopes[id]}))},limitations:[...limitations],
        stopReason:exhausted?"scope_exhausted":matches.length>=limit?"result_limit":"execution_budget"};
    },
  };
}
function decode(text:string):Cursor {
  if(text.length>4096)fail("context_cursor_invalid");
  try{const value:unknown=JSON.parse(Buffer.from(text,"base64url").toString("utf8"));if(!value||typeof value!=="object")fail("context_cursor_invalid");return value as Cursor;}
  catch{fail("context_cursor_invalid");}
}
function fail(code:string):never {throw new ContextMaterialError(code,code);}

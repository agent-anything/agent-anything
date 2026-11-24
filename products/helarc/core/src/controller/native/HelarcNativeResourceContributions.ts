import type {RunResourceContribution,RunResourceContributionSource} from "@agent-anything/agent-runtime/execution-coordinator";
import type {ProtocolExecutionJournal,ProtocolUsageSnapshot,ProtocolUsageCursor} from "@agent-anything/agent-runtime/model-access";
import {decodeNativeWorkIndexEntryMetadata,uniqueNativeWorkEntries} from "@agent-anything/provider-integrations/native";
import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";

/** Read-only accounting consumer. It does not restore participants or request a model. */
export function createHelarcNativeResourceContributions(journal:ProtocolExecutionJournal):RunResourceContributionSource {
  const id="helarc.native-physical-work";
  return {id,dimensions:["modelInputTokens","modelOutputTokens","costUnits"],async read(runId,previous){
    if(previous&&(previous.source!==id||previous.runId!==runId))throw new TypeError("native_resource_previous_scope_changed");
    const cursor=readCursor(previous);
    const result=await collectUsage(journal,runId,cursor?.complete?cursor.boundary:undefined);
    if("unchangedBoundary" in result){
      if(!previous||!cursor?.complete||result.unchangedBoundary!==cursor.boundary)throw new TypeError("native_resource_boundary_changed");
      return previous;
    }
    if("changedBoundary" in result){
      const value:Omit<RunResourceContribution,"revision">={source:id,runId,sequence:(previous?.sequence??-1)+1,
        cursor:JSON.stringify({boundary:result.changedBoundary,complete:false}),usage:{
          modelInputTokens:{knownValue:previous?.usage.modelInputTokens?.knownValue??0,status:"unknown"},
          modelOutputTokens:{knownValue:previous?.usage.modelOutputTokens?.knownValue??0,status:"unknown"},
          costUnits:{knownValue:previous?.usage.costUnits?.knownValue??0,status:"unknown"}}};
      return {...value,revision:digest({value,basis:previous?.revision??null,reason:"collection_boundary_changed"})};
    }
    if(result.runId!==runId||!Number.isSafeInteger(result.boundary)||result.boundary<0)throw new TypeError("native_resource_snapshot_scope_changed");
    const entries=result.entries.map(evidence=>{
      const entry=decodeNativeWorkIndexEntryMetadata(evidence.metadata,evidence.memberships);
      if(entry.runId!==runId||entry.workId!==evidence.key||evidence.kind!=="usage")throw new TypeError("native_resource_index_scope_changed");
      return entry;
    });
    const unique=uniqueNativeWorkEntries(entries);
    const missing=result.dispatches.filter(record=>!result.entries.some(entry=>entry.references.some(ref=>
      ref.activityId===record.activityId&&ref.id===record.content.id&&ref.digest===record.content.digest&&ref.bytes===record.content.bytes)));
    const covered=result.complete&&!missing.length&&!unique.conflictingWorkIds.length;
    const generations=unique.entries.filter(entry=>entry.operation==="generation"||entry.operation==="compact");
    const quantity=(dimension:"input"|"output")=>{
      let knownValue=0,complete=covered;
      for(const entry of generations){
        const tokens=dimension==="input"?entry.inputTokens:entry.outputTokens;
        const state=dimension==="input"?entry.inputState:entry.outputState;
        if(state==="known"&&tokens!==null){knownValue+=tokens;if(!Number.isSafeInteger(knownValue))throw new TypeError("native_resource_quantity_overflow");}
        else if(state!=="not_applicable")complete=false;
      }
      return {knownValue,status:complete?"measured" as const:"unknown" as const};
    };
    // Money has native currencies and rate provenance. No implicit conversion
    // from an arbitrary currency to the Run's generic costUnits is permitted.
    const value:Omit<RunResourceContribution,"revision">={source:id,runId,sequence:(previous?.sequence??-1)+1,
      cursor:JSON.stringify({boundary:result.boundary,complete:true}),
      usage:{modelInputTokens:quantity("input"),modelOutputTokens:quantity("output"),
        costUnits:{knownValue:0,status:covered&&!unique.entries.length?"not_applicable":"unknown"}}};
    return {...value,revision:digest({value,contributions:unique.entries.map(entry=>({id:entry.workId,revision:entry.revision})),
      missing:missing.map(record=>({activityId:record.activityId,ref:record.ref})),conflicts:unique.conflictingWorkIds,complete:result.complete})};
  }};
}

function readCursor(previous:RunResourceContribution|null):{boundary:number;complete:boolean}|null {
  if(previous?.cursor===undefined)return null;
  const cursor=JSON.parse(previous.cursor);
  if(!cursor||!Number.isSafeInteger(cursor.boundary)||cursor.boundary<0||typeof cursor.complete!=="boolean")
    throw new TypeError("native_resource_cursor_invalid");
  return cursor;
}

async function collectUsage(journal:ProtocolExecutionJournal,runId:string,ifBoundary?:number):Promise<
  ProtocolUsageSnapshot|{unchangedBoundary:number}|{changedBoundary:number}> {
  let boundary:number|undefined,after:ProtocolUsageCursor|undefined;
  const entries:ProtocolUsageSnapshot["entries"][number][]=[],dispatches:ProtocolUsageSnapshot["dispatches"][number][]=[];
  const cursors=new Set<string>();
  while(true){
    const page=await journal.command({kind:"usage_snapshot",runId,limit:128,
      ...(after?{after,expectedBoundary:boundary!}:ifBoundary!==undefined?{ifBoundary}:{})}) as
      ProtocolUsageSnapshot|{unchangedBoundary:number}|{changedBoundary:number};
    if("unchangedBoundary" in page){if(after)throw new TypeError("native_resource_page_invalid");return page;}
    if("changedBoundary" in page)return page;
    if(page.runId!==runId||!Number.isSafeInteger(page.boundary)||page.boundary<0||
      boundary!==undefined&&boundary!==page.boundary)throw new TypeError("native_resource_page_scope_changed");
    boundary=page.boundary;entries.push(...page.entries);dispatches.push(...page.dispatches);
    if(page.complete)return {runId,boundary,entries,dispatches,complete:true};
    if(!page.next||cursors.has(JSON.stringify(page.next)))throw new TypeError("native_resource_page_incomplete");
    after=page.next;cursors.add(JSON.stringify(after));
  }
}

import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {snapshotModelConversationSeed,type ModelConversationSeed} from "./TaskConversation.js";
import {snapshotNativeTaskHistoryEntries,type NativeTaskHistory,type NativeTaskHistoryEntry} from "./NativeTaskHistory.js";
import {snapshotInputPresentation,type RetainedInputPresentation} from "./DecisionInputDelivery.js";

/** Source-owned context around a closed history, not fabricated native exchanges. */
export interface NativeTaskHistoryBoundary {
  readonly opening:readonly RetainedInputPresentation[];
  readonly closing:readonly RetainedInputPresentation[];
}

export interface NativeTaskHistorySeed {
  readonly kind:"native_evidence";
  readonly sourceRunId:string;
  readonly sourceRevision:string;
  readonly segments:readonly {readonly runId:string;readonly revision:string;readonly entries:readonly NativeTaskHistoryEntry[];readonly boundary?:NativeTaskHistoryBoundary}[];
  readonly digest:string;
}
export type TaskInteractionSeed=ModelConversationSeed|NativeTaskHistorySeed;
export function isNativeTaskSeed(seed:TaskInteractionSeed):seed is NativeTaskHistorySeed{return "kind" in seed&&seed.kind==="native_evidence";}
export function createNativeTaskHistorySeed(runId:string,history:NativeTaskHistory,boundary?:NativeTaskHistoryBoundary):NativeTaskHistorySeed {
  if(history.unsettledCalls.length||!history.entries.length&&!boundary?.opening.length)throw new TypeError("native_import_history_not_closed");
  const value={kind:"native_evidence" as const,sourceRunId:runId,sourceRevision:history.revision,
    segments:[...(history.seed?.segments??[]),{runId,revision:history.revision,entries:history.entries,...boundary?{boundary}:{}}]};
  return snapshotTaskInteractionSeed({...value,digest:digest(value)}) as NativeTaskHistorySeed;
}
/** Import records source occurrences, never new Calls to execute or old authority to reuse. */
export function snapshotTaskInteractionSeed(value:TaskInteractionSeed):TaskInteractionSeed {
  if(!isNativeTaskSeed(value))return snapshotModelConversationSeed(value);
  const {digest:hash,...body}=value;
  if(hash!==digest(body)||!Array.isArray(value.segments)||!value.segments.length||value.segments.length>128||
    value.segments.at(-1)?.runId!==value.sourceRunId||value.segments.at(-1)?.revision!==value.sourceRevision||
    new Set(value.segments.map(s=>s.runId)).size!==value.segments.length)throw new TypeError("native_import_source_invalid");
  for(const segment of value.segments){
    if(!segment.runId||!segment.revision)throw new TypeError("native_import_source_invalid");
    const checked=snapshotNativeTaskHistoryEntries(segment.runId,segment.entries);
    if(checked.unsettledCalls.length||digest(checked.entries)!==digest(segment.entries))throw new TypeError("native_import_history_not_closed");
    if(!segment.entries.length&&!segment.boundary?.opening.length)throw new TypeError("native_import_opening_missing");
    if(segment.boundary){
      if(!Array.isArray(segment.boundary.opening)||!Array.isArray(segment.boundary.closing)||
        segment.entries.length&&segment.boundary.opening.length)throw new TypeError("native_import_boundary_invalid");
      const ids=new Set<string>();
      for(const value of [...segment.boundary.opening,...segment.boundary.closing]){
        const {section}=snapshotInputPresentation(value);
        if(ids.has(section.id)||section.role!=="user"||section.kind!=="conversation_opening"||section.content.kind!=="text"||
          section.provenance?.recipientRunId!==segment.runId||section.source.runId!==segment.runId)
          throw new TypeError("native_import_boundary_invalid");
        ids.add(section.id);
      }
    }
  }
  return Object.freeze(structuredClone(value));
}

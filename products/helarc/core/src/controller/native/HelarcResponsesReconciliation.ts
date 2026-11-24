import {retainProtocolContent,type ProtocolJournalPart,type ProtocolJournalRecord,type ProtocolReconciliationHandoff,
  type ProtocolExecutionState} from "@agent-anything/agent-runtime/model-access";
import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import type {ResponsesSessionState} from "@agent-anything/provider-integrations/native";
import {HelarcResponsesSessionStore,type HelarcResponsesSessionCustody} from "./HelarcResponsesSessionStore.js";

/** Transfer original responsibility, not a replacement generation. The receiver accepts before the producer exits. */
export async function handoffHelarcResponses(custody:HelarcResponsesSessionCustody,state:ResponsesSessionState,expiresAt:number):Promise<ProtocolReconciliationHandoff>{
  if(!state.cancellation||state.head.terminal||expiresAt<=state.lastAt||
    expiresAt>(state.cancelEpisode?.deadlineAt??expiresAt))throw new TypeError("responses_handoff_ineligible");
  const id=`${custody.id}:reconciliation`,old=await custody.journal.command({kind:"reconciliation",activityId:custody.fence.activityId,id}) as ProtocolReconciliationHandoff|null;
  if(old)return old;
  const record=await checkpoint(custody,state,"handoff");
  const handoff:ProtocolReconciliationHandoff={id,activityId:custody.fence.activityId,receiver:custody.scope.owner,checkpoint:record.ref,
    dependencies:[...custody.original,record.content],dueAt:state.dueAt??state.lastAt,expiresAt,disposition:null};
  await accept(custody,[{owner:"protocol_execution",kind:"record",proposal:{record,fence:custody.fence}},
    {owner:"protocol_execution",kind:"reconciliation_handoff",proposal:{fence:custody.fence,handoff}}]);
  return handoff;
}
export async function closeHelarcResponsesHandoff(custody:HelarcResponsesSessionCustody,state:ResponsesSessionState):Promise<void>{
  if(!state.followUp||!["terminal","unresolved","unsent"].includes(state.disposition)||state.pending)throw new TypeError("responses_handoff_still_active");
  const record=await checkpoint(custody,state,"disposition");
  await accept(custody,[{owner:"protocol_execution",kind:"record",proposal:{record,fence:custody.fence}},
    {owner:"protocol_execution",kind:"reconciliation_close",proposal:{fence:custody.fence,id:state.followUp,
      disposition:{basis:record.ref,outcome:state.disposition==="unresolved"?"unresolved":"resolved"}}}]);
}
async function checkpoint(c:HelarcResponsesSessionCustody,state:ResponsesSessionState,kind:string):Promise<ProtocolJournalRecord>{
  const accepted=await new HelarcResponsesSessionStore(c).observe();
  if(accepted?.revision!==state.revision||accepted.metadata.bindingDigest!==state.bindingDigest)throw new TypeError("responses_handoff_checkpoint_changed");
  const execution=await c.journal.command({kind:"state",activityId:c.fence.activityId}) as ProtocolExecutionState|null;
  if(!execution?.cancelled)throw new TypeError("responses_handoff_control_missing");
  const value={session:c.id,revision:state.revision,content:accepted.content,disposition:state.disposition,reason:state.reason};
  const ref={id:`${c.id}:${kind}:${digest(value)}`,revision:"1"};
  const content=await retainProtocolContent(c.journal,`${ref.id}:content`,c.fence.activityId,Buffer.from(JSON.stringify(value)),c.observe);
  return {ref,activityId:c.fence.activityId,operationId:`${c.id}:control`,kind:"owner_checkpoint",content,source:null,
    dependencies:accepted.dependencies.map(d=>d.ref)};
}
async function accept(c:HelarcResponsesSessionCustody,parts:ProtocolJournalPart[]){
  const proposal={scope:c.scope.runId,actor:c.scope.owner,parts},id=`responses-handoff:${digest(proposal)}`;
  try{const receipt=await c.acceptance.accept({id,...proposal});if(receipt.outcome!=="accepted")throw new TypeError(`responses_handoff_rejected:${receipt.rejection?.code}`);}
  catch(error){if((await c.acceptance.query(id))?.outcome!=="accepted")throw error;}
}

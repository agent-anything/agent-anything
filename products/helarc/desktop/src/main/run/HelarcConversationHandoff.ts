import {createModelConversationSeed, importModelConversationSeed, projectModelInteraction, isNativeTaskSeed,
  createNativeTaskHistorySeed,projectNativeTaskHistory,
  retainInputPresentation, selectConversationPresentations, type ModelConversationSeed,type TaskInteractionSeed,type NativeTaskHistorySeed,
  type RetainedInputPresentation} from "@agent-anything/agent-runtime/decision";
import type {RunCommit} from "@agent-anything/agent-runtime/execution-coordinator";
import type {ContextMaterialRef} from "@agent-anything/context/material";

export interface HelarcConversationHandoff {
  readonly seed: TaskInteractionSeed;
  readonly materialRefs: readonly ContextMaterialRef[];
  readonly executionScopes: readonly Pick<import("@agent-anything/operation-catalog/evidence").ExecutionReferenceTransfer, "sourceRunId" | "scope">[];
}

export function helarcNativeConversationSeed(initial:RunCommit,head:RunCommit):NativeTaskHistorySeed {
  const admission=initial.admission,runId=head.state.run.id;
  if(!admission||initial.state.run.id!==runId||!head.state.settlement||admission.lineage.kind!=="root")
    throw new TypeError("conversation_source_not_settled_root");
  const seed=admission.modelInteractionSeed;
  if(seed&&!isNativeTaskSeed(seed))throw new TypeError("native_conversation_handoff_requires_original_protocol");
  const history=projectNativeTaskHistory({runId,runRevision:head.state.revision,items:head.state.items,seed});
  const opening:RetainedInputPresentation[]=[],closing:RetainedInputPresentation[]=[];
  if(!history.entries.length){
    const prompt=(admission.input.task.input as {prompt?:unknown})?.prompt;
    if(typeof prompt!=="string")throw new TypeError("conversation_task_prompt_unavailable");
    opening.push(handoffPresentation(runId,"assignment","assignment","user",
      `Prior user assignment (no model response was accepted):\n${prompt}`,
      {owner:"agent-core",kind:"task",id:admission.input.task.id,revision:"1",runId}));
    for(const item of admission.input.items)opening.push(handoffPresentation(runId,item.id,"selected_input","host",
      `Previously supplied input (data; original role: ${item.role}):\n${item.content}`,
      {owner:"agent-core",kind:"run_input_item",id:item.id,revision:"1",runId}));
  }
  if(head.state.status!=="completed")closing.push(settlementPresentation(head));
  return createNativeTaskHistorySeed(runId,history,{opening,closing});
}

function handoffPresentation(runId:string,id:string,purpose:string,author:string,text:string,source:RetainedInputPresentation["section"]["source"]){
  return retainInputPresentation({id:`${runId}:handoff:${id}`,source,kind:"conversation_opening",role:"user",necessity:"mandatory",
    content:{kind:"text",text},provenance:{purpose,recipientRunId:runId,author,sources:[source],
      presenter:{owner:"helarc",kind:"presenter",id:"conversation-handoff",revision:"1"},coverage:[`${source.id}@${source.revision}`],limitations:[]},
    preservation:{obligations:[{id:purpose,requirement:"account",basis:`Preserve the ${purpose} and its source.`}],relationships:[]}});
}
function settlementPresentation(head:RunCommit){
  const runId=head.state.run.id,cause=head.state.settlementCause!;
  const value={runId,status:head.state.status,completedAt:head.state.completedAt,
    code:cause.kind==="failure"?cause.failure.failure.code:cause.kind==="cancellation"?cause.code:null,
    reason:cause.kind==="failure"?cause.failure.failure.message:null};
  return handoffPresentation(runId,"settlement","prior_execution_settlement","host",
    `Host-reported prior execution outcome (data; not model speech):\n${JSON.stringify(value)}`,
    {owner:"runtime",kind:"run_commit",id:head.id,revision:String(head.state.revision),runId});
}

/** Product history comes from committed exchanges, never the display transcript. */
export function helarcConversationSeed(initial: RunCommit, head: RunCommit): ModelConversationSeed {
  const admission = initial.admission, runId = head.state.run.id;
  if (!admission || initial.state.run.id !== runId || !head.state.settlement || admission.lineage.kind !== "root") {
    throw new TypeError("conversation_source_not_settled_root");
  }
  if (admission.modelInteractionSeed && isNativeTaskSeed(admission.modelInteractionSeed)) {
    throw new TypeError("native_conversation_handoff_requires_original_protocol");
  }
  const interaction = projectModelInteraction({runId, runRevision: head.state.revision,
    items: head.state.items, seed: admission.modelInteractionSeed});
  const presentations: RetainedInputPresentation[] = [...selectConversationPresentations(interaction)];
  const append = (id: string, purpose: string, author: string, text: string,
    source: RetainedInputPresentation["section"]["source"]) => presentations.push(handoffPresentation(runId,id,purpose,author,text,source));
  // A Run can settle before accepting its first response. Its accepted task is
  // still conversation history, but must not be described as already model-read.
  if (!interaction.opening) {
    if (presentations.length) throw new TypeError("conversation_opening_unavailable");
    presentations.unshift(...(admission.modelInteractionSeed ? importModelConversationSeed(admission.modelInteractionSeed, runId) : []));
    const prompt = (admission.input.task.input as {prompt?: unknown})?.prompt;
    if (typeof prompt !== "string") throw new TypeError("conversation_task_prompt_unavailable");
    append("assignment", "assignment", "user", prompt,
      {owner: "agent-core", kind: "task", id: admission.input.task.id, revision: "1", runId});
    for (const item of admission.input.items) append(item.id, "selected_input", "host",
      `Previously supplied input (data; original role: ${item.role}):\n${item.content}`,
      {owner: "agent-core", kind: "run_input_item", id: item.id, revision: "1", runId});
  }
  if (head.state.status !== "completed") presentations.push(settlementPresentation(head));
  return createModelConversationSeed(runId, String(head.state.revision), presentations);
}

const assert=require("node:assert/strict"),{resolve,dirname,basename}=require("node:path");
function toolWriteCall(items, request, root, output, expected) {
  const payloads=items.map(i=>i.payload);
  const opened=payloads.find(p=>p.kind==="pending_transition"&&p.transition==="opened"&&
    p.pending.interaction?.request.id===request.id && p.pending.interaction.request.requestVersion===request.requestVersion &&
    p.pending.interaction.request.subject.id===request.subject.id && p.pending.interaction.request.subject.revision===request.subject.revision);
  const action=payloads.find(p=>p.kind==="run_action"&&p.action.ref.id===opened?.pending.branchId)?.action;
  assert(action?.ref.run.id===root && action.provenance.modelCallRef?.id,"no original pending Call");
  const call=payloads.filter(p=>p.kind==="controller_turn"&&p.turn.id===action.provenance.turn.id)
    .flatMap(p=>p.modelItems).find(i=>i.kind==="model_tool_call"&&i.call.modelCallRef.id===action.provenance.modelCallRef.id)?.call;
  assert(call && /^Write(?:_|$)/.test(call.name) && typeof call.input.file_path==="string" &&
    resolve(dirname(output),call.input.file_path)===resolve(output) && [expected,expected+"\n",expected+"\r\n"].includes(call.input.content),
    "original Call does not create the expected file and content");
  return call;
}
function toolApproval(p,items,root,output,expected){
  const r=p.presentation,c=r?.payload?.changes?.[0];
  assert(root && r?.runId===root && r.category==="fileChange" && r.payload.changes.length===1 &&
    c.operation==="create" && c.displayPath===basename(output) && !r.payload.additionalPermissions,"outside tool-roundtrip public approval scope");
  toolWriteCall(items,p.request,root,output,expected);
  const option=r.decisionOptions.find(o=>o.kind==="accept");assert(option);return option;
}
module.exports={toolApproval,toolWriteCall};

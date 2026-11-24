// Source-side rubric for one historical sample. No labels or keys from this file enter production.
const assert=require("node:assert/strict");
function rubric(groups,duties,truth){
  const [background,objective,w,wr,r,rr]=groups;
  assert(background&&duties.length===4&&groups.length===6);
  const wc=w.items[0],rc=r.items[0],result=JSON.parse(wr.items[0].output).result,read=JSON.parse(rr.items[0].output).result;
  assert.equal(wc.call_id,wr.items[0].call_id);assert.equal(rc.call_id,rr.items[0].call_id);
  assert.equal(result.output.operation,"created");assert.equal(result.output.previous_baseline,null);
  assert.equal(result.output.file_support.material.reason,"file_material_read_not_authorized");
  assert.equal(read.output.truncated,false);assert.equal(read.output.end_line,read.output.total_lines);
  assert(read.output.content.includes("replacement identifier is "+truth.current+"; it applies only in mode "+truth.condition));
  const anchor=(g,excerpt)=>({groupId:g.id,excerpt});
  const fact=(key,owners,claim,necessity,sources,required=true)=>({key,dutyIds:owners.map(i=>duties[i].dutyId),claim,necessity,sources,required});
  return [
    fact("wcall",[0],"Write requested receipt.txt containing REVIEWED.","Distinguish the request from an observed effect.",[anchor(w,wc.arguments)]),
    fact("wtext",[0],"No accompanying user-facing text is recorded for Write.","Diagnostic, no later step depends on the absence.",[anchor(w,wc.call_id)],false),
    fact("wlink",[0,1],"The first settled result is for the Write on receipt.txt.","Do not attribute the receipt effect to another call.",[anchor(w,wc.call_id),anchor(wr,wc.call_id)]),
    fact("wstatus",[1],"The receipt write succeeded.","An unexecuted or unsuccessful request does not open the review.",[anchor(wr,'"settlement":"succeeded"')]),
    fact("created",[1],"Write confirmed creation, not just a write of unspecified kind.","Preserve what actually changed without inferring it from the assignment.",[anchor(wr,'"operation":"created"')]),
    fact("preimage",[1],"There is no independently captured pre-write baseline.","Do not claim old contents or available rollback material.",[anchor(wr,'"previous_baseline":null')]),
    fact("auth",[1],"Prior material was not captured because file-material read was not authorized.","Detail for an authority or rollback investigation, not a continuation requirement here.",[anchor(wr,"file_material_read_not_authorized")],false),
    fact("progress",[1],"A successful receipt opens the review but does not complete it.","Avoid claiming the entire assignment finished.",[anchor(wr,'"operation":"created"'),anchor(objective,"it marks that the review is open")]),
    fact("rcall",[2],"Second response called Read on calibration.txt without offset or limit.","Identify the completed step without repeating it.",[anchor(r,rc.arguments)]),
    fact("rtext",[2],"No accompanying user-facing text is recorded for Read.","Diagnostic only.",[anchor(r,rc.call_id)],false),
    fact("rlink",[2,3],"Second settled result belongs to the Read of calibration.txt.","Retain the provenance of the signed correction.",[anchor(r,rc.call_id),anchor(rr,rc.call_id)]),
    fact("rstatus",[3],"The calibration read succeeded and returned the record.","Do not treat the requested read alone as delivery.",[anchor(rr,'"settlement":"succeeded"')]),
    fact("extent",[3],"The first ledger was returned in full, not a fragment.","The user prohibited re-reading; a partial read has different consequences.",[anchor(rr,'"truncated":false'),anchor(objective,"Do not modify or reread")]),
    fact("pending",[2],"At this prefix boundary bench.txt had not been confirmed read.","Historical progress is not the current state after appending the bench suffix.",[anchor(r,rc.call_id),anchor(objective,"bench.txt")]),
    fact("correction",[3],"The draft was withdrawn and replaced with "+truth.current+".","The final report needs the corrected value, not the draft.",[anchor(rr,"replacement identifier is "+truth.current)]),
    fact("mode",[3],"The replacement applies only in mode "+truth.condition+".","An unconditional replacement is not the signed correction.",[anchor(rr,"only in mode "+truth.condition)])
  ];
}
// Each pair is an independent semantic annotation of the saved public wording and answer.
const annotations=[
  [["wcall","demonstrated"]],[["wtext","demonstrated"]],
  [["wstatus","demonstrated"],["created","insufficient","Successful write does not distinguish creation from overwrite."]],
  [["wlink","demonstrated"]],[["wstatus","demonstrated"],["created","not_asked","Settlement status does not explicitly ask for change type."]],
  [["preimage","demonstrated"],["auth","not_asked","Asked what was captured, not why."]],
  [["progress","demonstrated"]],[["rcall","demonstrated"]],[["rtext","demonstrated"]],
  [["rstatus","demonstrated"],["extent","not_asked","Returning a record does not explicitly ask whether it was a complete read."]],
  [["pending","demonstrated"]],[["rlink","demonstrated"]],
  [["rstatus","demonstrated"],["extent","not_asked","Asked for settlement, not the boundary of returned content."]],
  [["correction","demonstrated"]],[["mode","demonstrated"]]
];
module.exports={rubric,annotations};

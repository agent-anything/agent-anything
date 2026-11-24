const assert=require("node:assert/strict");

const line="Calibration entry: the recorded measurement was not independently verified.";
const header="Child result 7391. Measurements remain unverified; Child made no changes.";
const report=[header,...Array(60).fill(line)].join("\n");
const counted=body=>Math.ceil(Buffer.byteLength(JSON.stringify(body),"utf8")/4);
const capacity=13300;

function parentReply(items){
  const agent=items.find(item=>item.type==="function_call"&&/^Agent(?:_|$)/.test(item.name));assert(agent);
  const outputs=items.filter(item=>item.type==="function_call_output"&&item.call_id===agent.call_id);
  assert.equal(outputs.length,1);
  const summary=JSON.parse(outputs[0].output).result.output.summary;
  assert(summary.includes(header)&&summary.includes("60")&&summary.includes(line),"Parent lost a finding, uncertainty or multiplicity");
  assert(!summary.includes(line+"\n"+line),"Original repetitions were sent instead of the accepted shorter account");
}
module.exports={report,counted,capacity,parentReply};

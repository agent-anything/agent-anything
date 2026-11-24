const assert=require("node:assert/strict");
const ordinary=require("./native-application-ordinary.cjs");

const capacity=15800,threshold=13500;
const rootPrompt="HOST_ROOT: Delegate HOST_CHILD to report calibration result 7391 including all observations, uncertainty and changes. After delivery, write ORIGINAL to once.txt once, read it back and report both outcomes.";
function configure(draft,mode,target,dimensions){
  assert(["allow","uncovered"].includes(mode));
  return {...draft,inRequestCompaction:{revision:"1",target,origin:"external_evaluation",reviewedAt:"2026-11-18",
    basis:"Synthetic controlled peer and this fixture only",support:"accepted",trigger:{windowTokens:capacity,thresholdTokens:threshold,basis:"Controlled input counter and declared window"},
    profiles:[{id:"controlled-calibration",content:mode==="allow"?["text","function_calls"]:["text"],transports:["http"],continuities:["replay"],
      background:false,preservation:Object.fromEntries(dimensions.map(d=>[d,"accepted"])),repeated:"accepted",specialRequirements:[],
      limitations:["Controlled semantic continuation only; not evidence for a public model"]}]}};
}
function call(items){
  if(!items.some(i=>i.role==="user"&&JSON.stringify(i.content).includes("HOST_ROOT")))return {name:"final_result",values:{response:ordinary.report}};
  const calls=items.filter(i=>i.type==="function_call"),results=items.filter(i=>i.type==="function_call_output");
  assert.deepEqual(calls.map(i=>i.name.split("_")[0]),["Agent","Write","Read"].slice(0,calls.length));
  assert.deepEqual(results.map(i=>i.call_id),calls.map(i=>i.call_id));
  if(!results.length)return {name:"Agent",values:{description:"Report calibration",prompt:"HOST_CHILD: Report calibration 7391 including the 60 repeated observations, uncertainty and changes."}};
  assert.equal(JSON.parse(results[0].output).result.output.summary,ordinary.report);
  if(results.length===1)return {name:"Write",values:{file_path:"once.txt",content:"ORIGINAL"}};
  assert.equal(JSON.parse(results[1].output).settlement,"succeeded");
  if(results.length===2)return {name:"Read",values:{file_path:"once.txt"}};
  assert.equal(results.length,3);assert.equal(JSON.parse(results[2].output).settlement,"succeeded");assert(results[2].output.includes("ORIGINAL"));
  return {name:"final_result",values:{response:"Child result 7391. Calibration unverified. Parent wrote and read ORIGINAL once."}};
}
module.exports={capacity,threshold,rootPrompt,configure,call};

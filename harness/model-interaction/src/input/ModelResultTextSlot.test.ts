import {describe,expect,it} from "vitest";
import {createModelCallRef} from "../ModelCall.js";
import {declareModelResultTextSlot,fillModelResultTextSlot,fillModelResultTextSlots,readModelResultTextSlot,type ModelToolMessage} from "./ModelResultTextSlot.js";

function message():ModelToolMessage {
  return {role:"tool",content:["first","second"].map((name,index)=>({kind:"model_tool_result",result:{
    modelCallRef:createModelCallRef({providerRequestId:"request",controllerRequestId:"controller",turnId:"turn",contentBlockOrdinal:index,branchId:"parent"}),
    providerCallRef:{providerId:"provider",id:name},name,settlement:"failed",
    presentation:{presenter:{id:"owner",revision:"1"},disposition:"complete",failureCode:null},
    sourceRefs:[{owner:"child",kind:"result",id:`${name}:result`,revision:"1",runId:name}],
    content:{summary:"Original long report",status:"failed",failure_code:"build_failed",effect_status:"present",uncertainty:["unverified"]},
  }}))};
}
describe("source-declared result text position",()=>{
  it("validates multiple positions against one original before an atomic replacement",()=>{
    const original=message(),first=original.content[0]!.result.modelCallRef.id,second=original.content[1]!.result.modelCallRef.id;
    const replacements=[{slot:declareModelResultTextSlot(original,first,["summary"]),text:"First report"},
      {slot:declareModelResultTextSlot(original,first,["uncertainty",0]),text:"Still unverified"},
      {slot:declareModelResultTextSlot(original,second,["summary"]),text:"Second report"}];
    const next=fillModelResultTextSlots(original,replacements),expected=structuredClone(original);
    Object.assign(expected.content[0]!.result.content as object,{summary:"First report",uncertainty:["Still unverified"]});
    Object.assign(expected.content[1]!.result.content as object,{summary:"Second report"});
    expect(next).toEqual(expected);expect(fillModelResultTextSlots(original,[...replacements].reverse())).toEqual(next);
    expect(original).toEqual(message());
    expect(()=>fillModelResultTextSlots(original,[...replacements,replacements[0]!])).toThrow("replacement_invalid");
    expect(()=>fillModelResultTextSlots(original,[replacements[0]!,{...replacements[1]!,slot:{...replacements[1]!.slot,resultDigest:"stale"}}])).toThrow("source_changed");
    expect(original).toEqual(message());
  });
  it("changes only a result body leaf, preserving failed status, effects, native identity and sibling order",()=>{
    const original=message(),callId=original.content[0]!.result.modelCallRef.id;
    const slot=declareModelResultTextSlot(original,callId,["summary"]);
    const next=fillModelResultTextSlot(original,slot,"Checked shorter report");
    expect(readModelResultTextSlot(original,slot)).toBe("Original long report");
    const expected=structuredClone(original);
    (expected.content[0]!.result.content as Record<string,unknown>).summary="Checked shorter report";
    expect(next).toEqual(expected);expect(original).toEqual(message());
  });
  it("rejects stale source fields, not only changed summary text",()=>{
    const original=message(),slot=declareModelResultTextSlot(original,original.content[0]!.result.modelCallRef.id,["summary"]);
    const changed=structuredClone(original);
    (changed.content[0]!.result.content as Record<string,unknown>).effect_status="none";
    expect(()=>fillModelResultTextSlot(changed,slot,"short")).toThrow("source_changed");
    expect(()=>fillModelResultTextSlot(original,{...slot,textDigest:"changed"},"short")).toThrow("source_changed");
  });
  it("requires an exact existing string, never inventing a path or casting data to text",()=>{
    const original=message(),callId=original.content[0]!.result.modelCallRef.id;
    for(const path of [["missing"],["toString"],["uncertainty","0"],["summary","length"]])
      expect(()=>declareModelResultTextSlot(original,callId,path)).toThrow("path_invalid");
    expect(()=>declareModelResultTextSlot(original,callId,["uncertainty"])).toThrow("leaf_required");
    expect(()=>declareModelResultTextSlot(original,"missing",["summary"])).toThrow("call_invalid");
    const repeated={...original,content:[original.content[0]!,original.content[0]!]};
    expect(()=>declareModelResultTextSlot(repeated,callId,["summary"])).toThrow();
  });
  it("supports explicitly named array text and whole string bodies without exposing the protocol envelope",()=>{
    const original=message(),callId=original.content[0]!.result.modelCallRef.id;
    const slot=declareModelResultTextSlot(original,callId,["uncertainty",0]);
    expect(fillModelResultTextSlot(original,slot,"Still unverified").content[0]!.result.content)
      .toMatchObject({uncertainty:["Still unverified"]});
    const plain:ModelToolMessage={role:"tool",content:[{...original.content[0]!,result:{...original.content[0]!.result,content:"Original"}}]};
    expect(fillModelResultTextSlot(plain,declareModelResultTextSlot(plain,callId,[]),"").content[0]!.result.content).toBe("");
    expect(()=>declareModelResultTextSlot(original,callId,["modelCallRef","id"])).toThrow("path_invalid");
  });
});

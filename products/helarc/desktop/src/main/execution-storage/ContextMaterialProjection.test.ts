import {expect,it} from "vitest";
import type {RunCommit} from "@agent-anything/agent-runtime/execution-coordinator";
import {projectContextMaterials} from "./ContextMaterialProjection.js";

it("indexes accepted public views, not private instructions, reasoning or recursive access results",()=>{
  const section = (id:string,role:string,content:unknown) => ({section:{id,role,source:{owner:"test",kind:"assignment",id,revision:"1"},content}});
  const commit = {state:{run:{id:"child"},items:[{ref:{id:"turn-item",sequence:1},committedInRevision:2,payload:{kind:"controller_turn",status:"decided",
    openingReceipt:{presentations:[section("task","user",{kind:"text",text:"public task"}),section("private","instruction",{kind:"text",text:"hidden instruction"})]},
    modelItems:[{kind:"assistant_text",id:"reply",turnId:"turn",text:"public reply"},{kind:"assistant_reasoning",text:"hidden reasoning"}]}},
    {ref:{id:"result-item",sequence:2},committedInRevision:3,payload:{kind:"model_call_settlement",result:{presentation:{presenter:{id:"helarc.context-access-result"}},content:{text:"directory page"}}}}]},
    admission:{modelInteractionSeed:{sourceRunId:"prior-child",presentations:[section("structured","tool",{kind:"structured",value:{report:"retained summary"}})]}}} as unknown as RunCommit;
  const documents = projectContextMaterials(commit,0);
  expect(documents.map(value=>value.text)).toEqual(['{"report":"retained summary"}',"public task","public reply"]);
  expect(documents[0]?.description).toMatchObject({originRunId:"prior-child",format:"json",role:"tool"});
  expect(projectContextMaterials(commit,2)).toEqual([]);
  expect(JSON.stringify(documents)).not.toContain("hidden");
});

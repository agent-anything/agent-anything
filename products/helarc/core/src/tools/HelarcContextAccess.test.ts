import {expect,it} from "vitest";
import {contextMaterialDigest,ContextMaterialError,readContextMaterialText,type ContextMaterialDocument} from "@agent-anything/context/material";
import type {OperationResult} from "@agent-anything/operation-catalog/result";
import {createHelarcContextAccess} from "./HelarcContextAccess.js";
import {validateHelarcFinalMaterials} from "./HelarcMaterialHandoff.js";
import type {ProviderResponse} from "@agent-anything/model-interaction";

it("requires actual consistent bounded read bodies, not just a locator or a successful status",()=>{
  const doc:ContextMaterialDocument={text:"body",description:{reference:{id:"material",revision:contextMaterialDigest("body")},originRunId:"run",
    source:{owner:"test",kind:"report",id:"report",revision:"1"},label:"Report",role:"tool",position:1,bytes:4,format:"text",relationships:[],limitations:[]}};
  const result=readContextMaterialText(doc),contract=createHelarcContextAccess("2026-10-23T00:00:00.000Z")[1]!.contract;
  const valid=(output:unknown)=>contract.validateOutput({status:"succeeded",output} as OperationResult);
  expect(valid(result)).toBe(true);
  expect(valid({reference:doc.description.reference})).toBe(false);
  expect(valid({...result,text:""})).toBe(false);
  expect(valid({...result,nextOffset:0})).toBe(false);
});

it("returns correctable attachment errors before ending and never swallows a storage failure",async()=>{
  const refs=[{id:"shared",revision:contextMaterialDigest("body")}];
  const response={kind:"native_tool_turn",turn:{assistant:{content:[{kind:"model_tool_call",call:{name:"final_result",input:{material_refs:refs}}}]}}} as ProviderResponse;
  const access={read:async()=>{throw Error("unused");},search:async()=>{throw Error("unused");},validate:async()=>{throw new ContextMaterialError("context_material_unavailable","Not disclosed");}};
  expect(await validateHelarcFinalMaterials(response,"child",access)).toContain("successful work need not be repeated");
  await expect(validateHelarcFinalMaterials(response,"child",{...access,validate:async()=>{throw Error("disk failure");}})).rejects.toThrow("disk failure");
  expect(await validateHelarcFinalMaterials(response,"child",{...access,validate:async(run,received)=>{expect(run).toBe("child");expect(received).toEqual(refs);}})).toBeNull();
});

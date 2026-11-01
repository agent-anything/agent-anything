import {describe,it,expect,vi,beforeEach} from "vitest";
import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {readPreparedInputRejection} from "./PreparedInputRejection.js";
import {readModelInputRejections} from "../model-access/ModelInputRecovery.js";
import type {ActivityHandoffPort} from "../activity/index.js";
import type {PreparedContextInput} from "./ContextInputPreparation.js";
import type {InputSupplyBinding} from "./InputSupplyResponsibility.js";
vi.mock("../model-access/ModelInputRecovery.js",()=>({readModelInputRejections:vi.fn()}));
function fixture(){
  const prepared={demand:{runId:"root",recipient:"agent",purpose:"task",historyBoundary:"original"},encoded:{targetDigest:"target",bodyDigest:"body"}} as PreparedContextInput;
  const source={request:{id:"source",pathId:"consumer",input:{original:true}}};
  const binding:InputSupplyBinding={needId:"need",runId:"root",owner:"context-representation",consumerPathId:"consumer",
    source:{stageId:"source",requestDigest:digest(source.request)},configuration:{id:"config",revision:"1"}};
  const need={origin:{requestId:"rejected",receiptId:"receipt"},supplier:binding.owner,stage:{pathId:binding.consumerPathId}};
  const path={intent:{id:"consumer",runId:"root"}},original={request:{input:structuredClone(prepared)}};
  const activities={command:vi.fn(async(command:{kind:string;requestId?:string})=>command.kind==="read_input_need"?need:
    command.kind==="read_path"?path:command.requestId==="source"?source:original)} as unknown as ActivityHandoffPort;
  const rejection={stageId:"rejected",rawResultId:"raw",acceptanceId:"receipt",inputId:"input",encodedInputId:"encoded",targetDigest:"target",bodyDigest:"body"};
  vi.mocked(readModelInputRejections).mockResolvedValue([rejection]);
  return {prepared,binding,source,need,path,original,activities,rejection,run:()=>readPreparedInputRejection(activities,binding,prepared)};
}
describe("confirmed rejection before semantic checking",()=>{
  beforeEach(()=>vi.resetAllMocks());
  it("excludes identical bytes using validated ancestry, retaining the original rejection identity",async()=>{
    const f=fixture();expect(await f.run()).toEqual({stageId:"rejected",targetRevision:"target",bodyDigest:"body",evidence:{owner:"model-access",kind:"fact",id:"raw",revision:"receipt"}});
    expect(readModelInputRejections).toHaveBeenCalledWith(f.activities,f.path,f.need,"source");
  });
  it.each(["target","body"])("does not exclude changed %s",async changed=>{
    const f=fixture();Object.assign(f.prepared.encoded,{[changed==="target"?"targetDigest":"bodyDigest"]:"new"});expect(await f.run()).toBeNull();
  });
  it("does not invent a rejection without an accepted recovery origin",async()=>{
    const f=fixture();delete (f.need as {origin?:unknown}).origin;expect(await f.run()).toBeNull();expect(readModelInputRejections).not.toHaveBeenCalled();
  });
  it.each(["need","source","run","recipient","purpose","boundary"])("rejects changed %s",async change=>{
    const f=fixture();
    if(change==="need")f.need.stage.pathId="other";
    if(change==="source")Object.assign(f.source.request.input,{changed:true});
    if(change==="run")f.path.intent.runId="other";
    if(change==="recipient")Object.assign(f.original.request.input.demand,{recipient:"other"});
    if(change==="purpose")Object.assign(f.original.request.input.demand,{purpose:"other"});
    if(change==="boundary")Object.assign(f.original.request.input.demand,{historyBoundary:"other"});
    await expect(f.run()).rejects.toThrow("prepared_input_rejection_");
  });
  it("propagates missing original rejection evidence instead of treating it as no rejection",async()=>{
    const f=fixture();vi.mocked(readModelInputRejections).mockRejectedValue(new Error("original receipt missing"));
    await expect(f.run()).rejects.toThrow("original receipt missing");
  });
});

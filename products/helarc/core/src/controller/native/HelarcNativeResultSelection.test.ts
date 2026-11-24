import {describe,it,expect,vi} from "vitest";
import {createNativeModelCallRef,type ModelToolResult} from "@agent-anything/model-interaction";
import {OPENAI_RESPONSES} from "@agent-anything/model-interaction/protocol";
import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import type {ContextSelectionSnapshot} from "@agent-anything/context/selection";
import type {TaskDecisionInputSources} from "@agent-anything/agent-runtime/decision";
import type {HelarcAgentOutput} from "../HelarcController.js";
import {helarcResultTextDeclaration} from "../../prompt/HelarcResultTextDeclaration.js";
import {helarcNativeTaskResultDeliveries} from "./HelarcNativeTaskResultDelivery.js";
import {validateHelarcNativeResultSelection,type HelarcNativeResultSelectionPorts} from "./HelarcNativeResultSelection.js";
import type {HelarcNativeRunTask} from "./HelarcNativeTaskExecution.js";

const ref=(id:string)=>({id,revision:"1"});
function fixture(material=false){
  const scope={runId:"parent",activityId:"decision",recipientId:"parent-agent",purpose:ref("task"),compositionDigest:`sha256:${"a".repeat(64)}`};
  const source={scope,protocol:OPENAI_RESPONSES,interpretation:ref("responses"),operationId:"create",record:ref("reply"),
    position:{format:"json-pointer" as const,value:"/output/0"},nativeIdentity:{kind:"function_call",id:"fc1"}};
  const result:ModelToolResult={modelCallRef:createNativeModelCallRef({providerRequestId:"request",controllerRequestId:"decision",branchId:"parent",
    contentBlockOrdinal:0,nativeSource:source,purposeAcceptance:ref("accepted")}),providerCallRef:{providerId:"openai",id:"call1"},name:"Agent_a1",
    settlement:"succeeded",presentation:{presenter:ref("agent-runtime.observation"),disposition:"complete",failureCode:null},sourceRefs:[{owner:"child",kind:"result",id:"report",revision:"1"}],
    content:{kind:"descendant_run",status:"succeeded",output:{summary:material?"":"Original detailed findings",status:"completed",effect_status:"none",uncertainty:["unverified"],
      ...(material?{report:{status:"retained_material",reference:{id:"custody:original",revision:`sha256:${"b".repeat(64)}`},bytes:90000,inline:false}}:{})}}};
  const slot=helarcResultTextDeclaration(result,"declaration","1")!.slot;
  const item={type:"function_call_output",call_id:"call1",output:JSON.stringify({settlement:result.settlement,result:{...result.content as object,
    output:{...(result.content as any).output,summary:"Short findings; unverified"}}})};
  const body={input:[item]},presentation={groupId:"result-group",position:"/input/0",slot,representation:ref("short-report")};
  const prepared={binding:{scope},wire:{body:JSON.stringify(body),digest:digest(body)},selectedInputId:"selected",
    resultPresentations:[presentation],results:[{callId:slot.callId,position:"/input/0",contentDigest:digest(item)}]} as HelarcNativeRunTask;
  const input={runId:"parent",interaction:{kind:"native_evidence",entries:[{kind:"purpose"},{kind:"settlement",result}]}} as unknown as TaskDecisionInputSources<HelarcAgentOutput>;
  const bytes=Buffer.from("Short findings; unverified"),range={materialId:"report",version:"v1",coordinate:"bytes",start:0,end:bytes.length};
  const consumer={runId:"parent",recipient:"parent-agent",purpose:"task"};
  const originalRange={materialId:"original",version:`sha256:${"b".repeat(64)}`,coordinate:"bytes",start:0,end:90000};
  const snapshot={scope:{...consumer,target:"target"},selection:{representations:[presentation.representation]},
    input:{id:"selected",holds:[{id:"held",range,consumer},...(material?[{id:"source-held",range:originalRange,consumer}]:[])],exactInput:{prefixGroups:0,resultPresentations:[presentation],manifest:{protocol:OPENAI_RESPONSES,
      groups:[{id:"result-group",representation:ref("original-envelope"),items:[item]}]}}}} as unknown as ContextSelectionSnapshot;
  const record={ref:presentation.representation,runId:"child",purpose:"conversion",target:"method-target",body:range,
    declaredCoverage:[originalRange],inputs:[{material:originalRange}]};
  const reads=vi.fn(async(command?:{kind:string}):Promise<any>=>command?.kind==="resolve_reference"?{hold:{range:originalRange}}:{start:0,end:bytes.length,bytesBase64:bytes.toString("base64")});
  const ports={representations:{command:async()=>record},materials:{command:reads},maximumReadBytes:1024} as unknown as HelarcNativeResultSelectionPorts;
  return {result,prepared,input,snapshot,ports,reads,record};
}
describe("native source-declared result selection",()=>{
  it("requires the exact retained report source for a presentation replacing an empty summary",async()=>{
    const f=fixture(true);
    expect(helarcResultTextDeclaration(f.result,"original","1")?.source.kind).toBe("retained_material");
    await validateHelarcNativeResultSelection(f.prepared,f.input,f.snapshot,f.ports);
    expect(f.reads).toHaveBeenCalledWith(expect.objectContaining({kind:"resolve_reference",recipient:{runId:"parent",recipient:"parent-agent",purpose:"task"}}));
    f.record.declaredCoverage=[];
    await expect(validateHelarcNativeResultSelection(f.prepared,f.input,f.snapshot,f.ports)).rejects.toThrow("original_report_not_retained");
  });
  it("does not treat an unavailable external report as a source for a new summary",()=>{
    const f=fixture(true);(f.result.content as any).output.report.status="unavailable";
    expect(helarcResultTextDeclaration(f.result,"original","1")).toBeNull();
  });
  it("preserves the original settlement while verifying the actual selected shorter body",async()=>{
    const f=fixture();expect(helarcNativeTaskResultDeliveries(f.prepared,f.input)[0]!.result).toEqual(f.result);
    await validateHelarcNativeResultSelection(f.prepared,f.input,f.snapshot,f.ports);
    expect(f.reads).toHaveBeenCalledWith(expect.objectContaining({kind:"read",access:expect.objectContaining({holdId:"held",recipient:{runId:"parent",recipient:"parent-agent",purpose:"task"}})}));
    expect(f.result.modelCallRef.turnId).toBeNull();
  });
  it("rejects changes to effects, uncertainty, Call identity or settlement outside the declared text",()=>{
    for(const field of ["effect_status","uncertainty","settlement","call_id"]){
      const f=fixture(),body=JSON.parse(f.prepared.wire.body),item=body.input[0],value=JSON.parse(item.output);
      if(field==="call_id")item.call_id="different";
      else if(field==="settlement")value.settlement="failed";
      else value.result.output[field]=field==="uncertainty"?[]:"present";
      item.output=JSON.stringify(value);
      const changed={...f.prepared,wire:{body:JSON.stringify(body),digest:digest(body)},results:f.prepared.results.map(r=>({...r,contentDigest:digest(item)}))};
      expect(()=>helarcNativeTaskResultDeliveries(changed,f.input)).toThrow();
    }
  });
  it("rejects unbound and duplicate declarations, stale originals and absent selection",()=>{
    const f=fixture(),p=f.prepared.resultPresentations![0]!;
    for(const declarations of [[p,p],[{...p,position:"/input/1"}],[{...p,slot:{...p.slot,callId:"other"}}],[{...p,slot:{...p.slot,resultDigest:"changed"}}]])
      expect(()=>helarcNativeTaskResultDeliveries({...f.prepared,resultPresentations:declarations},f.input)).toThrow();
    expect(()=>helarcNativeTaskResultDeliveries({...f.prepared,selectedInputId:undefined},f.input)).toThrow();
  });
  it("rejects a body attributed to another group or a remote-only prefix",async()=>{
    for(const prefixGroups of [0,1]){
      const f=fixture(),snapshot=structuredClone(f.snapshot),native=snapshot.input.exactInput as any;
      native.prefixGroups=prefixGroups;
      if(!prefixGroups)native.manifest.groups[0].id="other-group";
      await expect(validateHelarcNativeResultSelection(f.prepared,f.input,snapshot,f.ports)).rejects.toThrow("group_position_invalid");
      expect(f.reads).not.toHaveBeenCalled();
    }
  });
  it("rechecks current access and rejects wrong recipients, bodies and read budget before acceptance",async()=>{
    const f=fixture();
    await expect(validateHelarcNativeResultSelection(f.prepared,f.input,f.snapshot,{...f.ports,maximumReadBytes:1})).rejects.toThrow("read_limit");
    expect(f.reads).not.toHaveBeenCalled();
    const wrong=structuredClone(f.snapshot);(wrong.input.holds[0]!.consumer as any).recipient="sibling";
    await expect(validateHelarcNativeResultSelection(f.prepared,f.input,wrong,f.ports)).rejects.toThrow("hold_missing");
    f.reads.mockRejectedValueOnce(new Error("material_access_revoked"));
    await expect(validateHelarcNativeResultSelection(f.prepared,f.input,f.snapshot,f.ports)).rejects.toThrow("access_revoked");
    const wrongBytes=Buffer.from("Wrong findings; unverified");
    f.reads.mockResolvedValueOnce({start:0,end:wrongBytes.length,bytesBase64:wrongBytes.toString("base64")});
    await expect(validateHelarcNativeResultSelection(f.prepared,f.input,f.snapshot,f.ports)).rejects.toThrow("body_changed");
  });
});

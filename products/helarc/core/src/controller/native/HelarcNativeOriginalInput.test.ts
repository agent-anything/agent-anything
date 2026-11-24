import {describe,it,expect,vi} from "vitest";
import {OPENAI_RESPONSES} from "@agent-anything/model-interaction/protocol";
import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {nativeInputBodyDigest} from "@agent-anything/agent-runtime/context-representation";
import {prepareHelarcNativeOriginalInput} from "./HelarcNativeOriginalInput.js";
import {HelarcNativeWorkingInput} from "./HelarcNativeWorkingSources.js";
import {prepareHelarcResponsesInRequestReception} from "./HelarcResponsesInRequestReception.js";
import {defaultHelarcInRequestCompactionPolicy} from "../../configuration/HelarcInRequestCompactionPolicy.js";

function fixture(options:{model?:string;requirement?:"exact"|"account";allowUnknown?:boolean}={}){
  const scope={id:"scope",runId:"root",recipient:"agent",purpose:"task",target:"config:1",owner:"context-representation",authorityBasis:"authority",continuity:"root"};
  const items=[{role:"user",content:"Keep the original objective"}],body={model:options.model??"original",store:false,input:items};
  const working=new HelarcNativeWorkingInput();
  working.append(items,{id:"objective",originRunId:"root",sources:[{source:{owner:"user",kind:"message",id:"message",revision:"1"},position:""}],
    duties:["objective"],preservation:{obligations:[{id:"objective",requirement:options.requirement??"exact",basis:"Original user objective"}],relationships:[]},exchangeId:null,protection:["first_delivery"],acceptedBy:null,representations:[]});
  const nativeScope={runId:"root",recipientId:"agent",activityId:"task",purpose:{id:"task",revision:"1"},compositionDigest:"composition"};
  const activity={scope:nativeScope,composition:{digest:"composition",composition:{protocol:OPENAI_RESPONSES,
    configuration:{configuration:{id:"config",revision:"1"},connectionBinding:{id:"connection",revision:"1"}}}}};
  const prepared={format:"helarc.native-prepared-task.v1",sourceDigest:"source",binding:{scope:nativeScope,protocol:OPENAI_RESPONSES},
    wire:{body:JSON.stringify(body),digest:digest(body)},workingSources:working.snapshot()};
  const inputNeed={kind:"native_input_need",revision:"1",needId:"demand:need",scope,consumer:{activityId:"task",protocol:OPENAI_RESPONSES,compositionDigest:"composition"}};
  const plan={revision:"1",activity,prepared,inputNeed,capacity:{limits:[{id:"bytes",targetRevision:"config:1",dimension:"request_bytes",maximum:10000,source:"test"}],
    reservations:[],policy:{id:"policy",revision:"1",purpose:"task",basis:"Original policy",allowUnknown:options.allowUnknown??false,allowEstimatedFit:false},maximumCombinations:1,maximumMeasurements:0}};
  const source={status:"accepted",request:{id:"demand:stage:1",pathId:"demand",stageKind:"source",input:{plan}},
    result:{id:"raw",outcome:"returned",completeness:"complete",value:{originalDigest:digest(prepared),sourceDigest:prepared.sourceDigest,bodyDigest:nativeInputBodyDigest(prepared.wire.body)}},
    receipt:{id:"receipt",owner:scope.owner,requestId:"demand:stage:1",resultId:"raw",progress:{contextInputNeed:inputNeed}}};
  const bytes=Buffer.from(JSON.stringify(items)),range={materialId:"history",version:"1",coordinate:"bytes",start:0,end:bytes.length};
  const record={ref:{id:"history",revision:"1"},runId:"root",owner:"material-source",purpose:"task",target:"config:1",form:"original",body:range,
    inputs:[{role:"source",material:range,representation:null}],declaredCoverage:[range],details:[],holds:["history"],requirements:[],losses:[],restorations:[],method:null};
  const hold={id:"history",instanceId:"instance",consumer:{runId:"root",recipient:"agent",purpose:"task"},responsibility:"preparation",range,basis:"capture",releaseCondition:"explicit"};
  const read=vi.fn(async(c:any)=>({start:c.offset,end:Math.min(c.offset+c.length,bytes.length),bytesBase64:bytes.subarray(c.offset,c.offset+c.length).toString("base64")}));
  const catalog=vi.fn(async()=>record);
  const input={plan,source,history:{record,hold},inputId:"input",selectionId:"selection",maximumReadBytes:10000,
    continuity:{kind:"responses",policy:"native_replay",previous:null,conditions:{basis:"original",authorized:true,disclosureRevision:"authority",remoteStorage:false,
      targetSupport:"established",predecessor:"unavailable",reestablish:false,policyChange:false}}};
  const run=(signal=new AbortController().signal)=>prepareHelarcNativeOriginalInput(input as unknown as Parameters<typeof prepareHelarcNativeOriginalInput>[0],
    {materials:{command:read},representations:{command:catalog}} as unknown as Parameters<typeof prepareHelarcNativeOriginalInput>[1],signal);
  return {input,run,read,catalog,bytes};
}

describe("unchanged native input option",()=>{
  it("proves identity without semantic inference, acceptance, or dispatch",async()=>{
    const f=fixture(),result=await f.run();
    expect(result.selected.wire).toEqual(f.input.plan.prepared.wire);
    expect(result.selected.workingSources).toEqual(f.input.plan.prepared.workingSources);
    expect(result.readiness.allowed).toBe(true);expect(result.proposal).not.toBeNull();
    expect(result.judgment).toMatchObject({kind:"combination",conclusion:"supported",methodRevision:"native-original-identity:1"});
    expect(result.judgment.evidenceSources?.map(s=>s.id)).toEqual(["demand:stage:1","raw","receipt"]);
    expect(f.catalog.mock.calls).toHaveLength(1);expect(result.readBytes).toBe(f.bytes.length);
  });
  it.each(["requestId","resultId","owner"] as const)("rejects a changed receipt %s before material access",async field=>{
    const f=fixture();f.input.source.receipt[field]="changed";
    await expect(f.run()).rejects.toThrow("source_invalid");expect(f.read).not.toHaveBeenCalled();
  });
  it("rejects an altered original body even when a caller recomputes its wire digest",async()=>{
    const f=fixture();f.input.plan.prepared.wire={body:JSON.stringify({model:"changed",input:[]}),digest:digest({model:"changed",input:[]})};
    await expect(f.run()).rejects.toThrow("source_invalid");expect(f.read).not.toHaveBeenCalled();
  });
  it.each(["runId","purpose","target"] as const)("rejects material from another %s",async field=>{
    const f=fixture();f.input.history.record[field]="changed";
    await expect(f.run()).rejects.toThrow("history_invalid");expect(f.read).not.toHaveBeenCalled();
  });
  it("does not equate exact identity with sufficient capacity",async()=>{
    const f=fixture();f.input.plan.capacity.limits[0]!.maximum=1;
    const result=await f.run();expect(result.readiness.allowed).toBe(false);expect(result.proposal).toBeNull();
    expect(result.judgment.conclusion).toBe("supported");expect(result.readiness.risks.length).toBeGreaterThan(0);
  });
  it("retains unknown capacity as unknown, not a measured fit",async()=>{
    const f=fixture();f.input.plan.capacity.limits=[];
    const result=await f.run();expect(result.readiness.allowed).toBe(false);expect(result.proposal).toBeNull();
  });
  it("rejects changed content and invalid page boundaries",async()=>{
    const f=fixture();f.read.mockImplementationOnce(async()=>({start:0,end:f.bytes.length,bytesBase64:Buffer.alloc(f.bytes.length,32).toString("base64")}));
    await expect(f.run()).rejects.toThrow();
    f.read.mockImplementationOnce(async()=>({start:0,end:0,bytesBase64:""}));await expect(f.run()).rejects.toThrow("page_invalid");
  });
  it("honors read limits, cancellation and revoked custody without fallback",async()=>{
    const f=fixture();f.input.maximumReadBytes=1;await expect(f.run()).rejects.toThrow("history_invalid");expect(f.read).not.toHaveBeenCalled();
    f.input.maximumReadBytes=10000;const control=new AbortController();control.abort(new Error("cancelled"));await expect(f.run(control.signal)).rejects.toThrow("cancelled");
    f.read.mockRejectedValueOnce(new Error("access_revoked"));await expect(f.run()).rejects.toThrow("access_revoked");
  });
});

describe("before-use reception of an unchanged native input",()=>{
  async function prepare(requirement:"exact"|"account"="account",enabled=true){
    const f=fixture({model:"gpt-5.3-codex",requirement,allowUnknown:true}),value=await f.run();
    type Input=Parameters<typeof prepareHelarcResponsesInRequestReception>[0];
    const input={original:{kind:"prepared",value,stage:{receipt:{id:"original-preparation-receipt"}}},
      inputId:"arranged-input",selectionId:"arranged-selection",activity:f.input.plan.activity,capacity:f.input.plan.capacity,
      use:{enabled,target:"original-use",transport:"http",continuity:"replay",background:false,
        policy:defaultHelarcInRequestCompactionPolicy({protocol:"openai.responses",model:"gpt-5.3-codex",target:"original-use",officialEndpoint:true})}} as unknown as Input;
    const result=await prepareHelarcResponsesInRequestReception(input,{},new AbortController().signal);
    return {f,value,result,input};
  }
  it("retains the original input and creates separately protected selection and agreement",async()=>{
    const {result,value}=await prepare();
    expect(result.kind).toBe("ready");if(result.kind!=="ready")return;
    const original=JSON.parse(value.selected.wire.body),arranged=JSON.parse(result.selected.wire.body);
    expect(arranged).toEqual({...original,context_management:[{type:"compaction",compact_threshold:200000}]});
    expect(original.context_management).toBeUndefined();
    expect(result.selected.workingSources).toEqual(value.selected.workingSources);
    expect(result.preparation.inputId).not.toBe(value.preparation.inputId);
    expect(result.selected.manifest.groups.flatMap(g=>g.holds)).not.toEqual(value.selected.manifest.groups.flatMap(g=>g.holds));
    expect(result.selected.compactionAgreement?.useEvidence?.use.policy?.origin).toBe("provider_documentation");
    expect(result.judgment.basis).toContain("not inspection of a future conversion");
    expect(result.proposal.parts.find(p=>p.owner==="material_custody"&&p.kind==="holds")?.proposal).toMatchObject({
      acquire:expect.arrayContaining([expect.objectContaining({responsibility:"input"}),expect.objectContaining({responsibility:"selection"})]),release:[]});
    expect(result.measurementUsage.measurementCalls).toBe(0);
  });
  it("never adds native options when disabled or exact preservation is required",async()=>{
    for(const [requirement,enabled] of [["account",false],["exact",true]] as const){
      const {value,result}=await prepare(requirement,enabled);
      expect(result.kind).toBe("unavailable");
      expect(JSON.parse(value.selected.wire.body).context_management).toBeUndefined();
    }
  });
  it("does not manufacture token measurements or bypass the original capacity policy",async()=>{
    const {input}=await prepare();
    const result=await prepareHelarcResponsesInRequestReception({...input,capacity:{...input.capacity,
      policy:{...input.capacity.policy,allowUnknown:false}}},{},new AbortController().signal);
    expect(result.kind).toBe("unavailable");
  });
});

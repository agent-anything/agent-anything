import {describe,it,expect} from "vitest";
import {modelInputValueDigest as digest,type ModelInputPreservation} from "@agent-anything/model-interaction/input";
import {OPENAI_RESPONSES} from "@agent-anything/model-interaction/protocol";
import {bindNativeInputManifest,nativeInputSettings} from "@agent-anything/provider-integrations/native";
import {defaultHelarcInRequestCompactionPolicy} from "../../configuration/HelarcInRequestCompactionPolicy.js";
import {HelarcNativeWorkingInput} from "./HelarcNativeWorkingSources.js";
import {assessHelarcResponsesInRequestUse,type HelarcResponsesInRequestUse} from "./HelarcResponsesInRequestEligibility.js";
import type {HelarcRetainedNativeInput} from "./HelarcNativeInputAcceptance.js";
import type {HelarcNativeInputDemandPlan} from "./HelarcNativeInputDemandWork.js";

const ref=(id:string)=>({id,revision:"1"});
function fixture(obligation:ModelInputPreservation["obligations"][number]={id:"task",requirement:"account",basis:"Preserve the accepted task"},
  items:readonly Record<string,unknown>[]=[{role:"user",content:"Keep the selected option and all unresolved work."}]){
  const working=new HelarcNativeWorkingInput();
  working.append(items,{id:"task-source",originRunId:"root",sources:[{source:{owner:"user",kind:"message",id:"prompt",revision:"1"},position:""}],
    duties:["objective"],preservation:{obligations:[obligation],relationships:[]},exchangeId:null,protection:["first_delivery"],acceptedBy:null,representations:[]});
  const body={model:"gpt-5.3-codex",input:items,store:false,stream:true},settings=nativeInputSettings(body);
  const manifest=bindNativeInputManifest({protocol:OPENAI_RESPONSES,scope:{id:"scope",runId:"root",recipientId:"task",purpose:ref("task"),compositionDigest:"composition"},
    target:{model:body.model,configuration:"configuration:1",connection:"connection:1",disclosure:"authority"},selection:{id:"selection",revision:"1",boundary:"boundary",judgments:["judgment"]},
    settings,settingSources:Object.keys(settings).map(field=>({field,source:"original",digest:digest(settings[field])})),
    groups:[{id:"original",representation:ref("original"),sources:["prompt"],holds:["hold"],deliveries:[],requires:[],items,replay:"local"}]});
  const native:HelarcRetainedNativeInput={kind:"helarc_native_input",manifest,wire:{body:JSON.stringify(body),digest:digest(body)},prefixGroups:0,predecessor:null,
    continuity:{kind:"responses",policy:"native_replay",previous:null,conditions:{basis:"original",authorized:true,disclosureRevision:"authority",
      remoteStorage:false,targetSupport:"established",predecessor:"unavailable",reestablish:true,policyChange:false}},workingSources:working.snapshot()};
  const use:HelarcResponsesInRequestUse={enabled:true,target:"target",transport:"http",continuity:"replay",background:false,
    policy:defaultHelarcInRequestCompactionPolicy({protocol:"openai.responses",model:body.model,target:"target",officialEndpoint:true})};
  const capacity:HelarcNativeInputDemandPlan["capacity"]={limits:[],reservations:[],maximumCombinations:32,maximumMeasurements:8,
    policy:{id:"capacity",revision:"1",purpose:"task",basis:"Original allowance for unknown measurements",allowUnknown:true,allowEstimatedFit:true}};
  return {native,use,capacity};
}
describe("native in-request compaction eligibility",()=>{
  it("permits only an adopted complete use profile, without claiming an evaluated artifact",()=>{
    const f=fixture(),r=assessHelarcResponsesInRequestUse(f);
    expect(r.allowed).toBe(true);expect(r.use.policy!.origin).toBe("provider_documentation");
    expect(r.duties.length).toBe(7);expect(r.trigger?.tokens).toBe(200000);
  });
  it("keeps disabled, unsupported and unknown scopes distinct",()=>{
    const f=fixture();
    expect(assessHelarcResponsesInRequestUse({...f,use:{...f.use,enabled:false}}).reasons).toContain("in_request_compaction_disabled");
    expect(assessHelarcResponsesInRequestUse({...f,use:{...f.use,target:"other"}}).reasons).toContain("method_use_policy_target_changed");
    expect(assessHelarcResponsesInRequestUse({...f,use:{...f.use,policy:null}}).reasons).toContain("method_use_policy_missing");
    expect(assessHelarcResponsesInRequestUse({...f,use:{...f.use,background:true}}).allowed).toBe(false);
    expect(assessHelarcResponsesInRequestUse({...f,use:{...f.use,transport:"websocket"}}).allowed).toBe(false);
  });
  it("cannot waive exactness, required direct inspection or an unassessed special requirement",()=>{
    for(const extra of [{requirement:"exact" as const},{permittedEvidence:["direct" as const]},
      {assuranceScope:{id:"numerical-provenance",revision:"3"}}]){
      const f=fixture({id:"task",requirement:"account",basis:"Explicit source obligation",...extra});
      expect(assessHelarcResponsesInRequestUse(f).allowed).toBe(false);
    }
    const f=fixture({id:"task",requirement:"account",basis:"Explicit source obligation",assuranceScope:{id:"numerical-provenance",revision:"3"}});
    const policy={...f.use.policy!,profiles:f.use.policy!.profiles.map(p=>({...p,specialRequirements:[{id:"numerical-provenance",revision:"3"}]}))};
    expect(assessHelarcResponsesInRequestUse({...f,use:{...f.use,policy}}).allowed).toBe(true);
  });
  it("does not merge independent partial profiles into proof of whole-input preservation",()=>{
    const f=fixture(),p=f.use.policy!,original=p.profiles[0]!;
    const profiles=[{...original,id:"one",preservation:{...original.preservation,references_and_changes:"unassessed" as const}},
      {...original,id:"two",preservation:{...original.preservation,execution_and_pending_work:"unassessed" as const}}];
    expect(assessHelarcResponsesInRequestUse({...f,use:{...f.use,policy:{...p,profiles}}}).allowed).toBe(false);
    expect(assessHelarcResponsesInRequestUse({...f,use:{...f.use,policy:{...p,profiles:[{...original,repeated:"unassessed"}]}}}).allowed).toBe(false);
  });
  it("does not classify unknown native content as safe text",()=>{
    const f=fixture(undefined,[{type:"unknown_native_item",payload:"Looks like ordinary text"}]);
    expect(assessHelarcResponsesInRequestUse(f).allowed).toBe(false);
  });
  it("requires an explicit usable threshold and preserves unknown generation headroom",()=>{
    const f=fixture(),policy=f.use.policy!;
    for(const trigger of [{...policy.trigger,windowTokens:null},{...policy.trigger,thresholdTokens:null}]){
      expect(assessHelarcResponsesInRequestUse({...f,use:{...f.use,policy:{...policy,trigger}}}).reasons)
        .toContain("compaction_trigger_basis_unavailable");
    }
    expect(()=>assessHelarcResponsesInRequestUse({...f,use:{...f.use,policy:{...policy,
      trigger:{...policy.trigger,thresholdTokens:policy.trigger.windowTokens}}}})).toThrow("in_request_compaction_trigger_invalid");
    const reservations:HelarcNativeInputDemandPlan["capacity"]["reservations"]=[{id:"generation",purpose:"generation",dimension:"shared_tokens",
      quantity:{kind:"unknown",reason:"No upper bound"},basis:"No known generation bound",alreadyIncluded:false}];
    const unknown={...f,capacity:{...f.capacity,reservations}};
    expect(assessHelarcResponsesInRequestUse(unknown).trigger?.basis).toContain("not a proven bound");
    expect(assessHelarcResponsesInRequestUse({...unknown,capacity:{...unknown.capacity,policy:{...f.capacity.policy,allowUnknown:false}}}).reasons)
      .toContain("generation_headroom_unknown");
    expect(assessHelarcResponsesInRequestUse({...f,capacity:{...f.capacity,reservations:[{...reservations[0]!,quantity:{kind:"exact",value:200001}}]}}).reasons)
      .toContain("compaction_trigger_basis_unavailable");
  });
});

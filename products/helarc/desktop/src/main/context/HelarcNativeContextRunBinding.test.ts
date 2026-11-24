import {describe,it,expect} from "vitest";
import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {contextSettingsSnapshot,matchHelarcNativeContextObservations,type HelarcContextCapabilityObservation} from "@agent-anything/helarc/configuration";
import {defaultProviderDraft,type ProviderConfiguration} from "../../shared/ProviderConfiguration.js";
import {bindHelarcNativeContextSettings,helarcNativeContextTarget,validateHelarcNativeContextRunBinding} from "./HelarcNativeContextRunBinding.js";
import {projectHelarcContextSettings} from "./HelarcContextSettingsProjection.js";
import {assessInputCapacity,type InputMeasurementEvidence} from "@agent-anything/model-interaction/input";
import {helarcWorkCapacityEvidence} from "./HelarcNativeCapacityEvidence.js";

function fixture(protocol:ProviderConfiguration["protocol"]="openai.responses"){
  const configuration:ProviderConfiguration={...defaultProviderDraft(protocol),id:"config",revision:"original",semanticRevision:"semantic",model:"model",
    connectionBindingId:"connection",credentialBackend:"none",credentialAvailability:"missing",availabilityObservedAt:null,
    targetAttribution:"provider_endpoint",archived:false,isDefault:false};
  const observation:HelarcContextCapabilityObservation={id:"observed",revision:"",target:helarcNativeContextTarget(configuration),duty:"assessment",
    method:{id:"check",revision:"1"},protocol,conclusion:"limited",dimensions:["coverage"],conditions:"Small supplied source",finding:"Missed a condition",
    source:"Manual review",limitations:"Not evaluated on current material",observedAt:"2026-11-16T00:00:00Z"};
  return {configuration,settings:contextSettingsSnapshot({autoRepresentation:true,observations:[observation]}).settings};
}
describe("Original native context configuration",()=>{
  it("freezes a per-generation budget without assigning a model window",()=>{
    const f=fixture(),budget=bindHelarcNativeContextSettings(f.settings,f.configuration,null,16384);
    expect(budget.target).toEqual(bindHelarcNativeContextSettings(f.settings,f.configuration).target);
    expect(()=>validateHelarcNativeContextRunBinding(JSON.parse(JSON.stringify(budget)))).not.toThrow();
    expect(()=>validateHelarcNativeContextRunBinding({...budget,maxInputTokensPerGeneration:17000})).toThrow();
    for(const bad of [0,-1,1.2,Infinity])expect(()=>bindHelarcNativeContextSettings(f.settings,f.configuration,null,bad)).toThrow();
    expect(()=>bindHelarcNativeContextSettings(f.settings,fixture("ollama.chat").configuration,null,16384)).toThrow();
    const {limits}=helarcWorkCapacityEvidence(f.configuration,"2026-11-23T00:00:00Z",budget);
    const targetRevision=limits.find(l=>l.requires)!.targetRevision;
    const evidence:InputMeasurementEvidence={id:"measured",encodedInputId:"wire",targetRevision,methodRevision:"1",dimension:"input_tokens",
      coverage:"complete",quantity:{kind:"estimate",value:100,limitations:["target_validity_unknown"]},basis:"count",uncovered:[]};
    const assess=(rows:InputMeasurementEvidence[])=>assessInputCapacity({encodedInputId:"wire",targetRevision,purpose:"test",limits,evidence:rows,reservations:[],
      policy:{id:"test",revision:"1",purpose:"test",basis:"test",allowEstimatedFit:true,allowUnknown:true}});
    expect(assess([]).allowed).toBe(false);expect(assess([evidence]).allowed).toBe(false);
    const measured=(tokens:number):InputMeasurementEvidence=>({...evidence,quantity:{kind:"estimate",value:tokens,limitations:["target_validity_unknown"]},observedInputCount:{receiptId:"receipt",tokens}});
    const atLimit=assess([measured(16384)]);expect(atLimit.allowed).toBe(true);
    expect(atLimit.decisions.map(d=>d.reason)).toContain("target_limits_unknown");
    expect(assess([measured(16385)]).allowed).toBe(false);
    expect(()=>assess([{...measured(100),coverage:"partial"}])).toThrow();
    expect(()=>assess([{...measured(100),encodedInputId:"other"}])).toThrow();
  });
  it("preserves old arrangements and refuses unknown comparison revisions even with a matching digest",()=>{
    const f=fixture(),{id,methodComparisonRevision,...legacy}=bindHelarcNativeContextSettings(f.settings,f.configuration);
    expect(methodComparisonRevision).toBe("15");
    const previous={...legacy,methodComparisonRevision:"14" as const};
    expect(()=>validateHelarcNativeContextRunBinding({...previous,id:"native-context-binding:"+digest(previous)})).not.toThrow();
    const original={...legacy,id:"native-context-binding:"+digest(legacy)};
    expect(()=>validateHelarcNativeContextRunBinding(original)).not.toThrow();expect(original.id).not.toBe(id);
    const unknown={...legacy,methodComparisonRevision:"later"};
    expect(()=>validateHelarcNativeContextRunBinding({...unknown,id:"native-context-binding:"+digest(unknown)})).toThrow("policy_unavailable");
  });
  it.each(["openai.responses","deepseek.chat-completions","ollama.chat"] as const)("binds %s without a legacy Provider profile",protocol=>{
    const f=fixture(protocol),binding=bindHelarcNativeContextSettings(f.settings,f.configuration);
    expect(()=>validateHelarcNativeContextRunBinding(binding)).not.toThrow();
    expect(binding.observations[0]).toMatchObject({match:"target_matched",limitations:["material_applicability_not_established","model_artifact_unknown"]});
    expect(binding.purposes.some(p=>p.ref.id==="helarc.responses-compact")).toBe(protocol==="openai.responses");
    expect(JSON.stringify(binding)).not.toContain("providerKind");
    const changed=bindHelarcNativeContextSettings(f.settings,{...f.configuration,revision:"later"});
    expect(changed.id).not.toBe(binding.id);expect(changed.observations[0]?.match).toBe("target_mismatch");
    expect(()=>validateHelarcNativeContextRunBinding(binding)).not.toThrow();
  });
  it("retains unknown artifacts and does not infer native ownership for historical observations",()=>{
    const f=fixture(),native=f.settings.observations[0]!;
    const legacy={...native,id:"legacy",target:{profileId:"config",providerKind:"openai-compatible",baseUrl:"https://api.openai.com/v1",model:"model",
      modelSettings:{service:"generic",thinking:{mode:"default"}},contextWindowTokens:null,artifact:null}};
    const settings=contextSettingsSnapshot({...f.settings,observations:[{...native,target:{...native.target,artifact:"specific"}},legacy]}).settings;
    const result=matchHelarcNativeContextObservations(settings,helarcNativeContextTarget(f.configuration));
    expect(result.map(o=>o.match)).toEqual(["target_unknown","target_mismatch"]);
    expect(matchHelarcNativeContextObservations(settings,helarcNativeContextTarget(f.configuration,"specific"))[0]?.match).toBe("target_matched");
  });
  it("validates frozen settings, evidence and purposes, not current settings",()=>{
    const f=fixture(),binding=bindHelarcNativeContextSettings(f.settings,f.configuration);
    for(const change of [{...binding,observations:[]},{...binding,policy:{...binding.policy,revision:"later"}},
      {...binding,settings:{...binding.settings,settings:{...binding.settings.settings,autoRepresentation:false}}}])
      expect(()=>validateHelarcNativeContextRunBinding(change)).toThrow();
  });
  it("projects only public native evidence and keeps its original revision",()=>{
    const f=fixture(),snapshot=contextSettingsSnapshot(f.settings),extended=structuredClone(snapshot),target=extended.settings.observations[0]!.target;
    if(!("kind" in target))throw new Error("Expected native target");
    Object.assign(target,{privateBinding:"PRIVATE"});Object.assign(target.configuration,{secret:"PRIVATE"});Object.assign(target.protocol,{secret:"PRIVATE"});
    const projected=projectHelarcContextSettings(extended);
    expect(projected).toEqual(snapshot);expect(contextSettingsSnapshot(projected.settings)).toEqual(snapshot);
    expect(JSON.stringify(projected)).not.toContain("PRIVATE");
  });
});

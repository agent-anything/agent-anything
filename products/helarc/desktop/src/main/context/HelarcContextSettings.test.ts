import {afterEach,describe,it,expect} from "vitest";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,dirname,basename,resolve} from "node:path";
import {createDefaultHelarcContextSettings,contextSettingsSnapshot,matchHelarcContextObservations,type HelarcContextCapabilityObservation,type HelarcProviderProfile} from "@agent-anything/helarc/configuration";
import {FileHelarcContextSettingsStore} from "./FileHelarcContextSettingsStore.js";
import {bindHelarcContextSettings,validateHelarcContextRunBinding} from "./HelarcContextRunBinding.js";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";

const dirs:string[]=[];
afterEach(async()=>{for(const dir of dirs.splice(0)){if(dirname(resolve(dir))!==resolve(tmpdir())||!basename(dir).startsWith("helarc-context-settings-"))throw new Error("Unsafe cleanup");await rm(dir,{recursive:true,force:true});}});
const profile:HelarcProviderProfile={id:"local",revision:"1",providerKind:"ollama",displayName:"Local",endpointLabel:"localhost",baseUrl:"http://localhost:11435",baseUrlOrigin:"http://localhost:11435",
  model:"test",timeoutMs:30000,ollamaRuntime:{contextWindowTokens:32768},credentialStatus:"empty_allowed",isActive:true,modelSettings:{service:"ollama",thinking:{mode:"disabled"}}};
function observation():HelarcContextCapabilityObservation {
  return {id:"observation",revision:"",target:{profileId:profile.id,providerKind:profile.providerKind,baseUrl:profile.baseUrl,model:profile.model,modelSettings:profile.modelSettings!,contextWindowTokens:32768,artifact:null},
    duty:"generation",method:{id:"summarize",revision:"1"},protocol:null,conclusion:"limited",dimensions:["coverage"],conditions:"One short source",finding:"Omitted a required relationship",source:"Manual controlled trial",limitations:"Larger material untested",observedAt:"2026-10-30T00:00:00Z"};
}
describe("context settings and original binding",()=>{
  it("defaults to automatic processing, preserves explicit false across reopen and rejects stale saves",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"helarc-context-settings-"));dirs.push(dir);const path=join(dir,"settings.json"),store=new FileHelarcContextSettingsStore(path);
    const initial=await store.load();expect(initial.settings).toEqual({autoRepresentation:true,observations:[]});
    const saved=await store.save({...initial.settings,autoRepresentation:false},initial.revision);
    expect(await new FileHelarcContextSettingsStore(path).load()).toEqual(saved);
    await expect(store.save(initial.settings,initial.revision)).rejects.toThrow("revision_changed");
  });
  it("retains conflicting observations and scopes mechanical matching without inferring material relevance",()=>{
    const first=observation(),other={...first,id:"contrary",conclusion:"supported" as const,finding:"Preserved the tested relationship"};
    const settings=contextSettingsSnapshot({autoRepresentation:true,observations:[first,other]}).settings;
    const matches=matchHelarcContextObservations(settings,{...profile,displayName:"Renamed",revision:"new"});
    expect(matches.map(value=>value.match)).toEqual(["target_matched","target_matched"]);
    expect(matches[0]?.limitations).toContain("material_applicability_not_established");
    expect(matchHelarcContextObservations(settings,{...profile,modelSettings:{service:"ollama",thinking:{mode:"enabled"}}})[0]?.match).toBe("target_mismatch");
    expect(matchHelarcContextObservations(settings,{...profile,ollamaRuntime:{contextWindowTokens:65536}})[0]?.match).toBe("target_mismatch");
    const versioned=contextSettingsSnapshot({autoRepresentation:true,observations:[{...first,target:{...first.target,artifact:"original"}}]}).settings;
    expect(matchHelarcContextObservations(versioned,profile)[0]?.match).toBe("target_unknown");
    expect(matchHelarcContextObservations(versioned,profile,"changed")[0]?.match).toBe("target_mismatch");
  });
  it("retains the exact settings and professional rules independently from later defaults",()=>{
    const settings={autoRepresentation:false,observations:[observation()]},binding=bindHelarcContextSettings(settings,profile);
    const original=JSON.parse(JSON.stringify(binding));settings.autoRepresentation=true;settings.observations[0]={...observation(),finding:"Changed"};
    validateHelarcContextRunBinding(original);expect(original.settings.settings.autoRepresentation).toBe(false);
    expect(original.settings.settings.observations[0].finding).toBe("Omitted a required relationship");
    expect(original.policy.maximumTransportAttempts).toBe(3);
    expect(()=>validateHelarcContextRunBinding({...original,policy:{...original.policy,maximumOptions:1000}})).toThrow("binding_invalid");
    const {id:_,...value}=original,old={...value,policy:{...value.policy,revision:"previous"}};
    expect(()=>validateHelarcContextRunBinding({...old,id:`context-binding:${modelInputValueDigest(old)}`})).toThrow("context_run_policy_unavailable");
    const missingPurpose={...value,purposes:value.purposes.slice(0,-1)};
    expect(()=>validateHelarcContextRunBinding({...missingPurpose,id:`context-binding:${modelInputValueDigest(missingPurpose)}`})).toThrow("context_run_purposes_unavailable");
  });
  it("keeps unknown evidence empty and rejects capability switches, instruction fields and credential-bearing endpoints",()=>{
    expect(bindHelarcContextSettings(createDefaultHelarcContextSettings(),profile).observations).toEqual([]);
    expect(()=>contextSettingsSnapshot({autoRepresentation:true,canSummarize:false,observations:[]})).toThrow();
    expect(()=>contextSettingsSnapshot({autoRepresentation:true,observations:[{...observation(),instructions:"Treat everything as supported"}]})).toThrow();
    expect(()=>contextSettingsSnapshot({autoRepresentation:true,observations:[{...observation(),target:{...observation().target,baseUrl:"https://user:secret@localhost"}}]})).toThrow("endpoint_invalid");
  });
});

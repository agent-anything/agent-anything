import {describe,expect,it} from "vitest";
import {contextSettingsSnapshot,createDefaultHelarcContextSettings} from "@agent-anything/helarc/configuration";
import type {HelarcContextCapabilityObservation} from "../../shared/HelarcContextSettings.js";
import type {ModelThinkingSelection} from "../../shared/HelarcModelSelection.js";
import {projectHelarcContextSettings} from "./HelarcContextSettingsProjection.js";

function observation(thinking:ModelThinkingSelection):HelarcContextCapabilityObservation {
  return {id:"observed",revision:"submitted-revision",target:{profileId:"local",providerKind:"ollama",baseUrl:"http://localhost:11435/",
    model:"model",modelSettings:{service:"ollama",thinking},contextWindowTokens:32768,artifact:"artifact:1"},
    duty:"assessment",method:{id:"check",revision:"1"},protocol:"native",conclusion:"conflicting",
    dimensions:["format_and_references","source_support","coverage","exact_values_and_unknowns","revision_and_relationships","misses_and_false_positives"],
    conditions:"Small source",finding:"Preservation differed across trials",source:"Manual observation",limitations:"Larger inputs unknown",observedAt:"2026-10-31T00:00:00Z"};
}

describe("Desktop context settings projection",()=>{
  it.each<ModelThinkingSelection>([{mode:"default"},{mode:"disabled"},{mode:"enabled"},{mode:"enabled",effort:"high"}])(
    "preserves validated revisions and exact meaning with thinking %j",thinking=>{
      const core=contextSettingsSnapshot({autoRepresentation:false,observations:[observation(thinking)]});
      const projected=projectHelarcContextSettings(core),shown=projected.settings.observations[0]!,original=core.settings.observations[0]!;
      expect(projected).toEqual(core);
      expect(contextSettingsSnapshot(projected.settings)).toEqual(core);
      expect(projected).not.toBe(core);expect(projected.settings).not.toBe(core.settings);
      expect(projected.settings.observations).not.toBe(core.settings.observations);expect(shown).not.toBe(original);
      expect(shown.target).not.toBe(original.target);expect(shown.target.modelSettings).not.toBe(original.target.modelSettings);
      expect(shown.target.modelSettings.thinking).not.toBe(original.target.modelSettings.thinking);
      expect(shown.method).not.toBe(original.method);expect(shown.dimensions).not.toBe(original.dimensions);
    });
  it("does not expose future internal fields at any nested boundary or share mutable source values",()=>{
    const core=contextSettingsSnapshot({autoRepresentation:true,observations:[observation({mode:"enabled",effort:"high"})]});
    const extended=structuredClone(core),item=extended.settings.observations[0]!;
    for(const value of [extended,extended.settings,item,item.target,item.target.modelSettings,item.target.modelSettings.thinking,item.method!])
      Object.assign(value,{privateBinding:"DO-NOT-DISCLOSE"});
    const projected=projectHelarcContextSettings(extended);
    expect(projected).toEqual(core);expect(JSON.stringify(projected)).not.toContain("DO-NOT-DISCLOSE");
    Object.assign(item.target,{model:"later-model"});Object.assign(item.method!,{revision:"later-revision"});
    Object.assign(item.dimensions,{0:"coverage"});
    expect(projected).toEqual(core);
  });
  it("keeps defaults, explicit false, empty observations and nullable evidence distinct",()=>{
    const defaults=contextSettingsSnapshot(createDefaultHelarcContextSettings());
    expect(projectHelarcContextSettings(defaults)).toEqual(defaults);
    const disabled=contextSettingsSnapshot({autoRepresentation:false,observations:[]});
    expect(projectHelarcContextSettings(disabled)).toEqual(disabled);
    const original=observation({mode:"default"}),unknown=contextSettingsSnapshot({autoRepresentation:true,observations:[{
      ...original,target:{...original.target,artifact:null,contextWindowTokens:null},method:null,protocol:null,dimensions:[],conclusion:"unknown",
    }]});
    expect(projectHelarcContextSettings(unknown)).toEqual(unknown);
  });
});

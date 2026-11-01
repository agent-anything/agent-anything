import {describe,expect,it,vi} from "vitest";
import {
  createAcceptedInputUsage,inputAccountingFootprint,measureFromAcceptedUsage,validateAcceptedInputUsage,
  type AcceptedInputUsage,type InputAccountingFootprint,
} from "./AcceptedInputUsage.js";
import {modelInputValueDigest} from "./ModelWorkingView.js";
import type {ModelInputComposition} from "./ModelInput.js";
import {createModelNativeInputFootprint,type ProviderInputAccounting} from "../context/ModelInputAccounting.js";
import {assessModelContext,createUnknownModelInputMeasurement,type ModelInputMeasurement} from "../context/ModelContext.js";
import type {ProviderUsage} from "../ProviderUsage.js";

const at="2026-11-01T00:00:00Z";
const footprint:InputAccountingFootprint={basisKey:"original-accounting",schemaDigest:"original-schema",bytes:400,inputUsage:"complete"};
const original={runId:"root",purpose:"task",targetRevision:"provider-target:1",encodedInputId:"encoded:1",stageId:"model:1",
  rawResultId:"raw:1",acceptanceId:"accepted:1",recordedAt:at,footprint};
const usage=(inputTokens=100):ProviderUsage=>({inputTokens,outputTokens:20,totalTokens:inputTokens+20,costUnits:null,metadata:{}});
const unknown=()=>createUnknownModelInputMeasurement({compositionId:"next-input",measuredAt:at,reason:"unsupported"});
function observation(changes:Partial<Omit<AcceptedInputUsage,"id">>={}):AcceptedInputUsage {
  const body={...original,inputTokens:100,...changes};
  return {...body,id:modelInputValueDigest(body)};
}
function derive(changes:Partial<Parameters<typeof measureFromAcceptedUsage>[0]>={}) {
  return measureFromAcceptedUsage({measurement:unknown(),footprint:{...footprint,bytes:601},runId:original.runId,
    purpose:original.purpose,targetRevision:original.targetRevision,observation:observation(),...changes});
}

describe("accepted complete-input usage evidence",()=>{
  it("binds the original encoded input, stage, raw response and professional acceptance",()=>{
    const result=createAcceptedInputUsage(original,usage());
    expect(result).toEqual(observation());
    expect(()=>validateAcceptedInputUsage(JSON.parse(JSON.stringify(result)))).not.toThrow();
    expect(createAcceptedInputUsage(original,{...usage(),metadata:{cachedInputTokens:100}})?.inputTokens).toBe(100);
  });
  it.each([
    ["missing response usage",null],
    ["missing input tokens",{...usage(),inputTokens:null}],
    ["zero tokens",usage(0)],["negative tokens",usage(-1)],
    ["fractional tokens",usage(1.5)],["unsafe token count",usage(Number.MAX_SAFE_INTEGER+1)],
    ["inconsistent accounting",{...usage(),metadata:{accountingConsistent:false}}],
    ["truncated input",{...usage(),metadata:{inputTruncated:true}}],
  ] as const)("excludes %s",(_label,value)=>{
    expect(createAcceptedInputUsage(original,value)).toBeNull();
  });
  it("requires complete input coverage without requiring output usage",()=>{
    expect(createAcceptedInputUsage({...original,footprint:{...footprint,inputUsage:"unknown"}},usage())).toBeNull();
    expect(createAcceptedInputUsage(original,{...usage(),outputTokens:null,totalTokens:null})?.inputTokens).toBe(100);
  });
  it.each(["runId","purpose","targetRevision","encodedInputId","stageId","rawResultId","acceptanceId","recordedAt"] as const)
    ("detects identity changes to %s",key=>{
      expect(()=>validateAcceptedInputUsage({...observation(),[key]:"replacement"})).toThrow("input_usage_identity_changed");
    });
  it("rejects self-consistent identities with invalid scope, time or measurement",()=>{
    expect(()=>validateAcceptedInputUsage(observation({runId:""}))).toThrow("input_usage_scope_invalid");
    expect(()=>validateAcceptedInputUsage(observation({recordedAt:"not-a-date"}))).toThrow("input_usage_measurement_invalid");
    expect(()=>validateAcceptedInputUsage(observation({inputTokens:0}))).toThrow("input_usage_measurement_invalid");
    expect(()=>validateAcceptedInputUsage(observation({footprint:{...footprint,inputUsage:"unknown"}}))).toThrow("input_usage_measurement_invalid");
  });
  it.each([0,-1,1.5,Number.MAX_SAFE_INTEGER+1])("rejects invalid byte extent %s",bytes=>{
    expect(()=>validateAcceptedInputUsage(observation({footprint:{...footprint,bytes}}))).toThrow("input_accounting_footprint_invalid");
  });
  it.each(["basisKey","schemaDigest"] as const)("rejects a non-string %s even when the observation digest matches",key=>{
    const invalid={...footprint,[key]:42} as unknown as InputAccountingFootprint;
    expect(()=>validateAcceptedInputUsage(observation({footprint:invalid}))).toThrow("input_accounting_footprint_invalid");
  });
});

describe("complete native input accounting footprint",()=>{
  const composition={id:"original-composition"} as ModelInputComposition;
  const native={messages:[{role:"user",content:"report \u4e2d\u6587"}],tools:[{name:"read",parameters:{type:"object"}}]};
  function accounting(changes:Partial<ProviderInputAccounting>={}):ProviderInputAccounting {
    return {basis:{adapter:"1",model:"original",endpoint:"local"},inputUsage:"complete",outputUsage:"unknown",
      defaultGenerationRoom:null,limitations:[],project:()=>createModelNativeInputFootprint(native),...changes};
  }
  it("uses the supplied native encoder projection, including UTF8 and definitions",()=>{
    const projected=createModelNativeInputFootprint(native),project=vi.fn(()=>projected),source=accounting({project});
    expect(inputAccountingFootprint(source,composition)).toEqual({basisKey:modelInputValueDigest({basis:source.basis,inputUsage:"complete",revision:"accepted-input-usage.v1"}),
      bytes:projected.bytes,schemaDigest:projected.schemaDigest,inputUsage:"complete"});
    expect(project).toHaveBeenCalledTimes(1);
    expect(project).toHaveBeenCalledWith(composition);
    expect(projected.bytes).toBeGreaterThan(JSON.stringify(native).length);
    expect(inputAccountingFootprint(undefined,composition)).toBeNull();
  });
  it("separates accounting basis and structure from text amount",()=>{
    const first=inputAccountingFootprint(accounting(),composition)!;
    expect(inputAccountingFootprint(accounting({basis:{adapter:"2",model:"original",endpoint:"local"}}),composition)!.basisKey).not.toBe(first.basisKey);
    expect(inputAccountingFootprint(accounting({inputUsage:"unknown"}),composition)!.basisKey).not.toBe(first.basisKey);
    const longer=inputAccountingFootprint(accounting({project:()=>createModelNativeInputFootprint({...native,messages:[{role:"user",content:"a much longer report"}]})}),composition)!;
    expect(longer.schemaDigest).toBe(first.schemaDigest);
    expect(longer.bytes).not.toBe(first.bytes);
    expect(inputAccountingFootprint(accounting({project:()=>createModelNativeInputFootprint({...native,tools:[]})}),composition)!.schemaDigest).not.toBe(first.schemaDigest);
  });
});

describe("measurement derived from comparable accepted usage",()=>{
  it("scales input bytes with ceiling and keeps the new composition identity",()=>{
    const result=derive();
    expect(result.measurement).toEqual({status:"measured",amount:151,estimator:{id:"accepted-input-byte-scaling",revision:"1",unit:"tokens",accuracy:"estimated"},
      uncertainty:{kind:"unquantified"},measuredCompositionId:"next-input",measuredAt:at});
    expect(result.derivation).toEqual({kind:"accepted_usage",observation:observation(),
      limitations:["unquantified_tokenization_error","reported_usage_is_not_a_capacity_guarantee"]});
  });
  it.each(["runId","purpose","targetRevision"] as const)("does not reuse usage across %s",key=>{
    const measurement=unknown(),result=derive({measurement,[key]:"other"});
    expect(result.measurement).toBe(measurement);
    expect(result.derivation).toEqual({kind:"unknown",observation:null,limitations:["accepted_input_usage_not_comparable"]});
  });
  it.each(["basisKey","schemaDigest"] as const)("does not reuse usage across %s",key=>{
    expect(derive({footprint:{...footprint,[key]:"other"}}).derivation)
      .toEqual({kind:"unknown",observation:null,limitations:["accepted_input_usage_not_comparable"]});
  });
  it("keeps missing or incomplete evidence unknown and rejects corrupted original evidence",()=>{
    expect(derive({footprint:null}).derivation.limitations).toEqual(["complete_input_accounting_unavailable"]);
    expect(derive({footprint:{...footprint,inputUsage:"unknown"}}).derivation.limitations).toEqual(["complete_input_accounting_unavailable"]);
    expect(derive({observation:null}).derivation.limitations).toEqual(["accepted_input_usage_unavailable"]);
    expect(()=>derive({observation:{...observation(),inputTokens:101}})).toThrow("input_usage_identity_changed");
  });
  it.each(["exact","upper_bound","estimated"] as const)("does not replace an existing provider %s measurement",accuracy=>{
    const measurement:ModelInputMeasurement={status:"measured",amount:83,estimator:{id:"provider",revision:"1",unit:"tokens",accuracy},
      uncertainty:{kind:"none"},measuredCompositionId:"next-input",measuredAt:at};
    const result=derive({measurement,observation:null,footprint:null});
    expect(result.measurement).toBe(measurement);
    expect(result.derivation).toEqual({kind:"provider",observation:null,limitations:[]});
  });
  it.each([100,1000])("never upgrades estimated capacity assessment with a %s-token bound",maximum=>{
    const result=derive(),assessment=assessModelContext({compositionId:"next-input",measurement:result.measurement,
      capacity:{supported:true,unit:"tokens",maximum,semantics:"input_only",source:"host_configured",providerId:"test",model:"model",revision:"1"},
      requestedOutput:{unit:"tokens",maximum:null,source:"unspecified",revision:"1"},
      headroom:{unit:"tokens",amount:0,policy:{id:"none",revision:"1"}},assessedAt:at,revision:"test"});
    expect(assessment.disposition).toBe(maximum===100?"estimated_overflow":"estimated_fit");
    expect(result.measurement).toMatchObject({estimator:{accuracy:"estimated"},uncertainty:{kind:"unquantified"}});
  });
  it("does not publish an unsafe numeric estimate",()=>{
    const result=derive({observation:observation({inputTokens:Number.MAX_SAFE_INTEGER,footprint:{...footprint,bytes:1}}),footprint:{...footprint,bytes:2}});
    expect(result.measurement.status).toBe("unknown");
    expect(result.derivation.limitations).toEqual(["input_usage_estimate_out_of_range"]);
  });
});

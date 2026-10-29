import {describe,expect,it} from "vitest";
import {composeInputChoice,inputChoiceGaps,type InputOrganizationDemand,type InputOption} from "./InputContribution.js";
import {assessInputCapacity,type InputCapacityPolicy,type MeasuredQuantity} from "./InputCapacityEvidence.js";
import {chargeInputCombination,nextInputCombination,recordInputCombination,startInputCombinationSearch} from "./InputCombinationSearch.js";
import {allocateInputCapacity,type LocalInputMeasurement} from "./InputCapacityAllocation.js";
import {modelInputValueDigest} from "./ModelWorkingView.js";

const policy:InputCapacityPolicy={id:"test-risk",revision:"1",purpose:"task",basis:"controlled test",allowEstimatedFit:true,allowUnknown:false};
function assessment(quantity:MeasuredQuantity, maximum=100, extra={}) {
  return assessInputCapacity({encodedInputId:"encoded",targetRevision:"target",purpose:"task",policy,
    limits:[{id:"limit",targetRevision:"target",dimension:"input_tokens",maximum,source:"test"}],
    evidence:[{id:"measurement",encodedInputId:"encoded",targetRevision:"target",methodRevision:"test",dimension:"input_tokens",coverage:"complete",quantity,basis:"independent count",uncovered:[]}],reservations:[],...extra});
}
function option(id:string,position:number,text=id):InputOption {
  return {id,revision:"1",duties:["objective","continuity"],sections:[{position,section:{id:`s${position}`,source:{owner:"test",kind:"user",id:`s${position}`,revision:"1"},kind:"task",role:"user",necessity:"mandatory",content:{kind:"text",text}}}],findings:[],requirements:[],requires:[],excludes:[],preference:0,estimatedCost:null,omissionBasis:null};
}
function demand():InputOrganizationDemand {
  return {id:"d",runId:"r",recipient:"agent",purpose:"task",targetRevision:"target",historyBoundary:"h",deliveryIds:["child-result"],dependencies:{},maximumCombinations:64,maximumExternalMeasurements:4,maximumReadBytes:1024,
    contributions:[{id:"a",owner:"organizer",sourceRevision:"1",deliveryIds:[],currentOptionId:"original",options:[option("original",0),option("short",0)],localBudget:{dimension:"input_tokens",grant:60,ceiling:null}},
      {id:"b",owner:"organizer",sourceRevision:"1",deliveryIds:["child-result"],currentOptionId:"original",options:[option("original",1),option("detail",1)],localBudget:{dimension:"input_tokens",grant:40,ceiling:null}}]};
}
describe("complete input organization and finite search",()=>{
  it("matches an independent complete Cartesian oracle without assuming monotonic option costs",()=>{
    const original=demand(),d={...original,contributions:original.contributions.map((c,index)=>({...c,options:[...c.options,option("third",index)]}))};
    let progress=startInputCombinationSearch(d);const actual:string[]=[];
    for(let i=0;i<10;i++) {
      const step=nextInputCombination(d,progress);if(step.kind!=="measure")break;
      actual.push(`${step.choice.a}/${step.choice.b}`);progress=recordInputCombination(d,step.progress,step.id,assessment({kind:"exact",value:200}));
    }
    const expected=d.contributions[0]!.options.flatMap(a=>d.contributions[1]!.options.map(b=>`${a.id}/${b.id}`));
    expect(actual.sort()).toEqual(expected.sort());expect(nextInputCombination(d,progress)).toMatchObject({kind:"gap",reason:"options_exhausted",untested:false});
  });
  it("returns unused local grants and reallocates shared space without borrowing past a ceiling",()=>{
    const d=demand(),choice={a:"original",b:"original"};
    const measurements:LocalInputMeasurement[]=d.contributions.map((c,index)=>({contributionId:c.id,optionId:"original",optionDigest:modelInputValueDigest(c.options[0]),
      dimension:"input_tokens",quantity:{kind:"exact",value:index===0?20:70},methodRevision:"test:1",basis:"independent local count"}));
    const allocation=allocateInputCapacity(d,choice,measurements,{dimension:"input_tokens",available:100,basis:"purpose grant"});
    expect(allocation.shares.map(s=>s.allocated)).toEqual([20,70]);expect(allocation.sharedRemainder).toBe(10);
    const bounded={...d,contributions:d.contributions.map(c=>({...c,localBudget:{...c.localBudget,ceiling:c.id==="b"?60:null}}))};
    expect(allocateInputCapacity(bounded,choice,measurements,{dimension:"input_tokens",available:200,basis:"purpose grant"})).toMatchObject({hardViolations:["b"]});
    expect(()=>allocateInputCapacity(d,choice,[{...measurements[0]!,optionDigest:"changed"}],null)).toThrow("stale");
  });
  it("does not treat an estimate as a proven local limit failure or combine unlike units",()=>{
    const original=demand(),d={...original,contributions:original.contributions.map(c=>({...c,localBudget:{...c.localBudget,ceiling:50}}))};
    const measurements:LocalInputMeasurement[]=d.contributions.map(c=>({contributionId:c.id,optionId:"original",optionDigest:modelInputValueDigest(c.options[0]),dimension:"input_tokens",
      quantity:{kind:"estimate",value:70,limitations:["not a guarantee"]},methodRevision:"test",basis:"estimate"}));
    const value=allocateInputCapacity(d,{a:"original",b:"original"},measurements,{dimension:"request_bytes",available:100,basis:"different unit"});
    expect(value.hardViolations).toEqual([]);expect(value.shares.every(s=>s.hardLimit==="unknown")).toBe(true);
    expect(value.shares.map(s=>s.allocated)).toEqual([50,40]);
  });
  it("explores simultaneous nonmonotonic replacements and restores the exact pending candidate",()=>{
    const d=demand();let progress=startInputCombinationSearch(d);const visited:string[]=[];
    for(let i=0;i<5;i++){
      const step=nextInputCombination(d,progress);if(step.kind!=="measure")break;
      expect(nextInputCombination(d,JSON.parse(JSON.stringify(step.progress)))).toEqual(step);
      visited.push(JSON.stringify(step.choice));
      const fits=step.choice.a==="short"&&step.choice.b==="detail";
      progress=recordInputCombination(d,step.progress,step.id,assessment({kind:"exact",value:fits?90:130}));
    }
    expect(nextInputCombination(d,progress)).toMatchObject({kind:"ready",choice:{a:"short",b:"detail"}});
    expect(new Set(visited).size).toBe(4);
  });
  it("reports finite untested options rather than no solution, retaining resource charges",()=>{
    const d={...demand(),maximumCombinations:1};const step=nextInputCombination(d,startInputCombinationSearch(d));
    if(step.kind!=="measure")throw new Error("expected candidate");
    let progress=chargeInputCombination(d,step.progress,{externalMeasurements:1,readBytes:256});
    progress=recordInputCombination(d,progress,step.id,assessment({kind:"exact",value:101}));
    expect(nextInputCombination(d,progress)).toMatchObject({kind:"gap",reason:"search_budget_exhausted",untested:true,progress:{externalMeasurements:1,readBytes:256}});
    expect(()=>chargeInputCombination(d,progress,{externalMeasurements:4,readBytes:0})).toThrow("resource_exhausted");
    expect(()=>nextInputCombination({...d,targetRevision:"changed"},progress)).toThrow("binding_invalid");
  });
  it("checks explicit companions without deriving relationships from conflicting text",()=>{
    const d=demand(),a=d.contributions[0]!,b=d.contributions[1]!;
    const next={...d,contributions:[{...a,options:[a.options[0]!,{...a.options[1]!,requires:[{contributionId:"b",optionId:"detail"}]}]},b]};
    expect(inputChoiceGaps(next,{a:"short",b:"original"})).toMatchObject([{kind:"relation"}]);
    expect(inputChoiceGaps(next,{a:"short",b:"detail"})).toEqual([]);
  });
  it("keeps source unknowns and bounded residual uncertainty, but not necessary preservation gaps",()=>{
    const d=demand(),a=d.contributions[0]!;
    const finding={id:"f",owner:"checker",basis:"original source",requirement:"method",outcome:"supported" as const,dependencies:{},uncertainty:"residual" as const};
    const tested=(uncertainty:"source"|"residual"|"preservation_gap")=>({...d,contributions:[{...a,options:[{...a.options[0]!,requirements:["method"],findings:[{...finding,uncertainty}]}]},d.contributions[1]!]});
    expect(inputChoiceGaps(tested("residual"),{a:"original",b:"original"})).toEqual([]);
    expect(inputChoiceGaps(tested("source"),{a:"original",b:"original"})).toEqual([]);
    expect(inputChoiceGaps(tested("preservation_gap"),{a:"original",b:"original"})).toMatchObject([{kind:"preservation"}]);
  });
  it("does not duplicate content for multiple duties or deduplicate separate delivery occurrences",()=>{
    const d=demand();const composition=composeInputChoice(d,{a:"original",b:"original"},{providerId:"p",model:"m",interaction:{kind:"text_generation"},
      lineage:lineage(),composedAt:"2026-10-29T00:00:00.000Z"});
    expect(composition.sections).toHaveLength(2);
    expect(composition.instructions.content).toEqual([]);
    expect(composition.messages).toHaveLength(1);
    expect(JSON.stringify(composition.messages)).toContain("original");
  });
});
describe("scope-specific capacity evidence",()=>{
  it("never calls an upper-bound overflow a proven violation",()=>{
    expect(assessment({kind:"bounds",lower:80,upper:130})).toMatchObject({allowed:false,decisions:[{conclusion:"uncertain"}]});
    expect(assessment({kind:"bounds",lower:101,upper:130})).toMatchObject({allowed:false,decisions:[{conclusion:"violated"}]});
  });
  it("does not let risk permission bypass known hard failure",()=>{
    expect(assessment({kind:"exact",value:101},100,{policy:{...policy,allowUnknown:true}})).toMatchObject({allowed:false,decisions:[{conclusion:"violated"}]});
    expect(assessment({kind:"estimate",value:99})).toMatchObject({allowed:true,decisions:[{conclusion:"estimated_fit"}]});
  });
  it("does not treat partial evidence or unknown generation as zero",()=>{
    expect(assessment({kind:"unknown",reason:"template unknown"})).toMatchObject({allowed:false});
    const evidence=[{id:"e",encodedInputId:"encoded",targetRevision:"target",methodRevision:"test",dimension:"input_tokens",coverage:"partial",quantity:{kind:"exact",value:50},basis:"text only",uncovered:["image"]}];
    expect(assessment({kind:"exact",value:50},100,{evidence})).toMatchObject({allowed:false,decisions:[{conclusion:"uncertain"}]});
  });
  it("keeps future growth out of current capacity and does not double-count included error",()=>{
    expect(assessment({kind:"exact",value:90},100,{reservations:[
      {id:"future",purpose:"future_growth",dimension:"input_tokens",quantity:{kind:"exact",value:500},basis:"forecast",alreadyIncluded:false},
      {id:"error",purpose:"measurement_error",dimension:"input_tokens",quantity:{kind:"exact",value:30},basis:"included upper bound",alreadyIncluded:true},
    ]})).toMatchObject({allowed:true});
  });
});

function lineage() {
  const ref={owner:"test",kind:"binding",id:"binding",revision:"1"};
  return {instructionBinding:ref,agent:ref,instructions:ref,instructionRelease:ref,instructionResolver:ref,instructionContent:ref,
    instructionModel:{providerId:"p",model:"m"},instructionBlocks:[],activeContext:null,contextProjection:null,projectionManifest:null,
    toolSelection:null,toolExposureContent:null,toolExposureBasis:null,toolExposureProof:null,toolGuidance:null,controllerControlGuidance:null,
    callableDefinitions:null,modelQualification:null,interactionHistory:null,protocol:ref,policy:ref};
}

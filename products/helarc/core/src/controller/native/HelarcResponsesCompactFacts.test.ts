import {describe,it,expect} from "vitest";
import {compileNativeSchema} from "@agent-anything/provider-integrations/native";
import {OPENAI_RESPONSES} from "@agent-anything/model-interaction/protocol";
import {assessCompactFacts} from "./HelarcResponsesCompactFacts.js";
import type {CompactChecksInput} from "./HelarcResponsesCompactChecks.js";

const ref=(id:string)=>({id,revision:"1"});
async function sample(opts:{rubric?:"invalid"|"empty"|"unasked";mark?:"insufficient"|"contradicted"|"unbound"|"missing"|"invalid";
  gap?:boolean;stop?:string}={}){
  const prefix=[{id:"g",items:[{type:"function_call_output",output:"Created a new file; prior image unknown."}]}],steps:string[]=[];
  const f={source:{sourceDigest:"src",groups:prefix,duties:[{id:"d",revision:"1",permittedEvidence:["continuation_probe"]}],
    manifest:{groups:prefix},dependencies:{},dutyBasis:[{dutyId:"d",description:"Retain the effect",sourceGroups:["g"]}]},
    outcome:{candidate:{digest:"c",items:[{type:"compaction",encrypted_content:"opaque"}]},evidence:{acceptance:ref("compact")}}};
  const findings=await assessCompactFacts({...f as unknown as Pick<CompactChecksInput,"source"|"outcome">,execute:async(step,items,schema)=>{
    steps.push(step);const req=JSON.parse(String(items.at(-1)!.content));let value;
    if(step==="oracle")value={facts:opts.rubric==="empty"?[]:[
      {key:"e",claim:"Creation",required:true,necessity:"distinguish overwrite",dutyIds:["d"],sources:[{groupId:"g",excerpt:opts.rubric==="invalid"?"Absent text":"Created"}]},
      {key:"p",claim:"Prior image unknown",required:false,necessity:"diagnostic for this recipient",dutyIds:["d"],sources:[{groupId:"g",excerpt:"prior image unknown"}]}],
      questions:opts.rubric==="empty"||opts.rubric==="unasked"?[]:[{question:"What changed?",factKeys:["e"]}]};
    else if(step==="probe"){
      expect(req.facts).toBeUndefined();expect(Object.keys(req.questions[0]).sort()).toEqual(["question","questionId"]);
      value={answers:[{questionId:req.questions[0].questionId,answer:opts.mark==="contradicted"?"Overwritten":"Created",limitations:[]}]};
    }else{
      value={checks:opts.mark==="missing"?[]:[{questionId:req.questions[0].questionId,factKey:"e",coverage:"asked",
        quality:opts.mark==="invalid"?"not_assessed":opts.mark==="insufficient"||opts.mark==="contradicted"?opts.mark:"demonstrated",
        reason:"Checked the actual effect",answerExcerpt:opts.mark==="unbound"?"invented":req.answers[0].answer}],
        gaps:opts.gap?[{dutyId:"d",missing:"Type of created object",reason:"Subsequent access differs for a file versus directory",groupId:"g",excerpt:"new file"}]:[]};
    }
    const codec=compileNativeSchema({protocol:OPENAI_RESPONSES,purpose:ref("context_compaction_assessment"),mode:"responses-strict",canonical:schema,root:"body"});
    expect(codec.parse(JSON.stringify(value))).toEqual(value);
    return {evidence:{acceptance:ref(step)},assessment:{outcome:step===opts.stop?"unavailable":"valid",value}} as unknown as Awaited<ReturnType<CompactChecksInput["execute"]>>;
  }});
  return {f:findings[0]!,steps};
}
describe("fact-based preservation admission",()=>{
  it("admits all proven required facts without requiring diagnostic detail",async()=>{
    const {f}=await sample();expect(f.conclusion).toBe("supported");
    expect(f.factAssessments?.map(v=>[v.required,v.status])).toEqual([[true,"demonstrated"],[false,"not_asked"]]);
  });
  it.each(["invalid","empty","unasked"] as const)("does not generate against a %s plan",async(rubric)=>{
    const {f,steps}=await sample({rubric});expect(f.conclusion).toBe("unknown");expect(steps).toEqual(["oracle"]);
  });
  it.each([["insufficient","unknown","insufficient"],["contradicted","unsupported","contradicted"],["invalid","unknown","unavailable"],
    ["missing","unknown","unavailable"],["unbound","unknown","unavailable"]] as const)("separates %s",async(mark,conclusion,status)=>{
    const {f}=await sample({mark});expect(f.conclusion).toBe(conclusion);expect(f.factAssessments?.[0]?.status).toBe(status);
  });
  it("preserves the frozen rubric on an unavailable probe; does not blame the answer",async()=>{
    const {f,steps}=await sample({stop:"probe"});expect(steps).toEqual(["oracle","probe"]);expect(f.factAssessments?.[0]?.status).toBe("unavailable");
    expect(f.purposeReceipts?.map(r=>r.id)).toEqual(["compact","oracle","probe"]);
  });
  it("records an independently identified missing requirement separately from the frozen answer findings",async()=>{
    const {f}=await sample({gap:true});expect(f.conclusion).toBe("unknown");expect(f.factAssessments?.[0]?.status).toBe("demonstrated");
    expect(f.planGaps?.[0]?.groupId).toBe("g");
  });
});

import {expect,it} from "vitest";
import {compileNativeSchema} from "@agent-anything/provider-integrations/native";
import {OPENAI_RESPONSES} from "@agent-anything/model-interaction/protocol";
import {assessCompactUse} from "./HelarcResponsesCompactUse.js";
import type {CompactChecksInput} from "./HelarcResponsesCompactChecks.js";

const ref=(id:string)=>({id,revision:"1"});
const call={type:"function_call",call_id:"one",name:"change",arguments:'{"target":"local"}'};
const output={type:"function_call_output",call_id:"one",output:'{"effect":"created"}'};
const reported={role:"assistant",content:'I confirmed the effect: {"effect":"created"}'};
async function review(items:Record<string,unknown>[],resultIndex:number,pointer="/effect",expectedJson='"created"'){
  const groups=items.map((i,n)=>({id:"actual-"+n,items:[i]})),steps:string[]=[];
  const fixture={source:{sourceDigest:"src",dependencies:{},groups,manifest:{groups},
    duties:[{id:"d",revision:"1",permittedEvidence:["continuation_probe"]}],
    dutyBasis:[{dutyId:"d",description:"Original evidence of the effect for audit; no new action.",sourceGroups:[groups[resultIndex]!.id]}]},
    outcome:{evidence:{acceptance:ref("method")},candidate:{digest:"opaque",items:[{type:"compaction",encrypted_content:"opaque"}]}}};
  const result=await assessCompactUse({...fixture as unknown as Pick<CompactChecksInput,"source"|"outcome">,
    execute:async(step,_items,schema)=>{
      steps.push(step);const group="g"+(resultIndex+1);
      const value=step==="oracle"?{requirements:[{duties:["d1"],claim:"The effect was creation.",necessity:"Attribute the historical effect to the right call.",
        sources:[{group,excerpt:"created"}],use:"original_receipt",question:"",resultGroup:group,pointer,expectedJson}]}:
        {reviews:[{id:"r1",source:"supported",sourceReason:"Controlled affirmative review.",coverage:"not_applicable",quality:"not_assessed",
          reason:"Check the independent original.",answerExcerpt:""}],duties:[{id:"d1",complete:true,reason:"Historical audit only."}],
          publicClaims:{conclusion:"supported",reason:"No new readable assertion."}};
      const codec=compileNativeSchema({protocol:OPENAI_RESPONSES,purpose:ref("context_compaction_assessment"),mode:"responses-strict",canonical:schema,root:"body"});
      expect(codec.parse(JSON.stringify(value))).toEqual(value);
      return {evidence:{acceptance:ref(step)},assessment:{outcome:"valid",value}} as unknown as Awaited<ReturnType<CompactChecksInput["execute"]>>;
    }});
  expect(steps).toEqual(["oracle","judgment"]);return result[0]!;
}
it("does not spend a blind probe to establish an original-only receipt field",async()=>{
  const result=await review([call,output],1);
  expect(result.conclusion).toBe("supported");expect(result.factAssessments?.[0]?.receiptWitness?.callGroup).toBe("actual-0");
});
it.each([
  [[reported],0],[[call,{...output,call_id:"two"}],1],[[call,call,output],2],
  [[call,output,output],1],[[output,call],0],
] as const)("does not certify assertions, wrong, duplicate or reversed receipts",async(items,index)=>{
  const result=await review([...items],index);
  expect(result.conclusion).toBe("unknown");expect(result.factAssessments?.[0]?.receiptWitness).toBeUndefined();
});
it("distinguishes a missing field from an observed conflict, regardless of semantic grader confidence",async()=>{
  const absent=await review([call,output],1,"/missing"),different=await review([call,output],1,"/effect",'"overwritten"');
  expect(absent.conclusion).toBe("unknown");expect(different.conclusion).toBe("unsupported");
  expect(absent.factAssessments?.[0]?.receiptWitness?.observedDigest).toBeNull();
  expect(different.factAssessments?.[0]?.receiptWitness?.observedDigest).toBeTruthy();
});

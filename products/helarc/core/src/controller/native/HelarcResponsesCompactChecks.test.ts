import {describe,expect,it} from "vitest";
import {assessScopedCompactChecks,visibleCompactFindings} from "./HelarcResponsesCompactChecks.js";

type Input=Parameters<typeof assessScopedCompactChecks>[0];
const ref=(id:string)=>({id,revision:"1"});
const message={role:"user",content:"Inspect the file."};
const prefix=[{id:"assignment",items:[message]},{id:"write",items:[{type:"function_call_output",output:"created"}]},
  {id:"other",items:[{type:"function_call_output",output:"overwritten"}]}];
function fixture():Pick<Input,"source"|"outcome">{
  return {source:{sourceDigest:"original",dependencies:{},manifest:{groups:prefix},groups:prefix,duties:[
    {id:"objective",revision:"1",permittedEvidence:["direct","continuation_probe"]},{id:"effect",revision:"1",permittedEvidence:["continuation_probe"]}],
    dutyBasis:[{dutyId:"objective",sourceGroups:["assignment"]},{dutyId:"effect",sourceGroups:["write"]}]},
    outcome:{candidate:{digest:"candidate",items:[{role:"user",type:"message",content:[{type:"input_text",text:message.content}]},{type:"compaction",encrypted_content:"opaque"}]},
      evidence:{acceptance:ref("compact")}}} as unknown as Pick<Input,"source"|"outcome">;
}
describe("scoped preservation evidence",()=>{
  it("requires a permitted role-preserving ordered witness, never an opaque or later occurrence",()=>{
    const f=fixture();expect(visibleCompactFindings(f).map(v=>v.dutyId)).toEqual(["objective"]);
    for(const items of [[{...message,role:"assistant"}],[{type:"compaction"},message],[{...message,content:"Different."}]]){
      expect(visibleCompactFindings({...f,outcome:{...f.outcome,candidate:{...f.outcome.candidate,items}}})).toEqual([]);
    }
    const source={...f.source,duties:f.source.duties.map(d=>({...d,permittedEvidence:["continuation_probe" as const]}))};
    expect(visibleCompactFindings({...f,source})).toEqual([]);
  });
  it("dispatches no assessment calls when every duty is directly established",async()=>{
    const f=fixture(),findings=await assessScopedCompactChecks({...f,source:{...f.source,duties:f.source.duties.slice(0,1)},
      execute:async()=>{throw new Error("unexpected generation");}});
    expect(findings.map(f=>f.kind)).toEqual(["direct"]);
  });
  it.each([
    ["supported","created","complete","It was created","supported"],
    ["supported","created","incomplete","It was created","unknown"],
    ["supported","created","complete","","unknown"],
    ["contradicted","created","complete","Only overwrite is possible","unsupported"],
    ["contradicted","overwritten","complete","Only overwrite is possible","unknown"],
    ["contradicted","created","complete","No information","unknown"],
    ["outside_question","created","incomplete","No identifier given","unknown"],
    ["changed-id","created","complete","Only overwrite is possible","unknown"],
  ])("handles %s (%s, %s, %s) as %s",async(status,excerpt,coverage,answer,expected)=>{
    const f=fixture(),stages:string[]=[];let checkId="";
    const findings=await assessScopedCompactChecks({...f,execute:async(step,items)=>{
      stages.push(step);const input=JSON.parse(String(items.at(-1)!.content));let value;
      if(step==="oracle")value={queries:[{dutyId:"effect",established:true,checks:[{question:"Was the file created?",expectedAnswer:"It was created",basis:"Original write result"}]}]};
      else if(step==="probe"){
        expect(items.slice(0,-1)).toEqual(f.outcome.candidate.items);
        expect(Object.keys(input.questions[0]).sort()).toEqual(["checkId","question"]);checkId=input.questions[0].checkId;
        value={answers:[{checkId,answer,limitations:[]}]};
      }else value={coverage:[{dutyId:"effect",complete:coverage==="complete",reason:"Coverage of public question."}],
        findings:[{checkId:status==="changed-id"?"unasked":checkId,status:status==="changed-id"?"supported":status,reason:"Compared with the original result.",
          answerExcerpt:"Only overwrite",sourceExcerpt:excerpt}]};
      return {evidence:{acceptance:ref(step)},assessment:{outcome:"valid",value}} as unknown as Awaited<ReturnType<Input["execute"]>>;
    }});
    expect(stages).toEqual(["oracle","probe","judgment"]);expect(findings.map(f=>f.conclusion)).toEqual(["supported",expected]);
  });
});


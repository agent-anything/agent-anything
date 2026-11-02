import {describe,expect,it} from "vitest";
import {contextProcessObject as object,contextProcessRelationship as relation,validateContextProcessEvidence,type ContextProcessEvidence} from "./ContextProcessEvidence.js";

function evidence():ContextProcessEvidence {
  const subject=object("context-representation","choice","parent");
  return {revision:"1",category:"decision",subject,state:{phase:"settled",status:"accepted"},related:[],
    relationships:[relation("observes",subject,object("material_custody","source",null,"original-version")),
      relation("prerequisite",object("activity","preparation","child"),subject,"required_context_result")]};
}
describe("owner-declared context process evidence",()=>{
  it("keeps independent recipient and exact source identities without inferring delivery",()=>{
    const value=evidence();expect(()=>validateContextProcessEvidence(value)).not.toThrow();
    expect(value.relationships[0]!.to).toEqual({owner:"material_custody",id:"source",runId:null,revision:"original-version"});
    expect(value.relationships[1]!.from.runId).toBe("child");
    expect(value.relationships.some(edge=>edge.kind==="delivers")).toBe(false);
  });
  it("allows an observation without a lifecycle update",()=>{
    expect(()=>validateContextProcessEvidence({...evidence(),state:null})).not.toThrow();
  });
  it("requires explicit bounded reuse counts and their basis",()=>{
    expect(()=>validateContextProcessEvidence({...evidence(),reuse:{eligibility:1,content:0,basis:"checked_not_consumed"}})).not.toThrow();
    expect(()=>validateContextProcessEvidence({...evidence(),reuse:{input:-1,basis:"invalid"}})).toThrow();
    expect(()=>validateContextProcessEvidence({...evidence(),reuse:{checks:1,basis:""}})).toThrow();
  });
  it("accepts declared judgment but rejects missing interpretation fields",()=>{
    const judgment={foreground:"continue",investment:"none",adoption:"keep",reason:"no_pressure",reconsiderOn:[],limitations:[],excluded:[]};
    expect(()=>validateContextProcessEvidence({...evidence(),judgment})).not.toThrow();
    expect(()=>validateContextProcessEvidence({...evidence(),judgment:{...judgment,reconsiderOn:null}})).toThrow();
  });
  it.each([undefined,{}, {...evidence(),revision:"other"},{...evidence(),subject:{id:"choice"}},
    {...evidence(),relationships:[{...evidence().relationships[0],condition:"result"}]},
    {...evidence(),relationships:[{...evidence().relationships[1],condition:null}]}])("rejects malformed evidence instead of guessing missing meaning",value=>{
    expect(()=>validateContextProcessEvidence(value)).toThrow();
  });
});

import {expect,it} from "vitest";
import {decideContextPreparation,type ContextPreparationPolicyInput,type ContextRecipientInputReadiness} from "./ContextPreparationPolicy.js";
import {contextPreparationDecisionEvidence} from "./ContextPreparationDecisionEvidence.js";

function fixture(){
  const scope={id:"scope",runId:"parent",recipient:"agent",purpose:"task",target:"target",continuity:"original",owner:"context-representation",authorityBasis:"authority"};
  const evidence={owner:"activity",kind:"fact" as const,id:"original:stage:1",revision:"1"};
  const source:ContextRecipientInputReadiness={kind:"recipient_prepared",scope,inputId:"original-input",bodyDigest:"body",exactInputDigest:"exact",
    judgmentId:"original-identity",allowed:true,risks:[],evidence};
  const input:ContextPreparationPolicyInput={scope,boundary:"boundary",requirementsDigest:"requirements",current:source,currentRejectedInputId:null,
    alternatives:[],pressure:[{kind:"input_capacity_risk",inputId:source.inputId,evidence}],options:[],inFlight:[],explorationHistory:[],optionalInFlight:0,
    autoPrepare:true,consumerActive:true,receptionOptions:[{id:"arrangement",members:[],sourceInput:source,
      addresses:[evidence.id],comparisons:[],evidence:{...evidence,id:"arrangement-basis"}}]};
  return {source,input};
}
it("proposes an input arrangement without inventing a producer or blocking usable original input",()=>{
  const {input}=fixture(),decision=decideContextPreparation(input);
  expect(decision.policy.revision).toBe("14");
  expect(decideContextPreparation(input,"legacy").policy.revision).toBe("11");
  expect(decision.foreground).toMatchObject({kind:"continue",preparedInputId:"original-input",adoption:"keep"});
  expect(decision.investment).toEqual({kind:"prepare_input",optionId:"arrangement",reason:"opportunity"});
  const evidence=contextPreparationDecisionEvidence({input,decision,investment:null,acceptanceId:"acceptance"},[]);
  expect(evidence.relationships.some(r=>r.from.id==="arrangement"&&r.to.id==="original-input")).toBe(true);
});
it("keeps prior producer-only policy meaning and requires an explicit source for an empty membership",()=>{
  const {input}=fixture();
  expect(decideContextPreparation({...input,receptionOptions:[]},"legacy").policy.revision).toBe("10");
  const {sourceInput:_,...option}=input.receptionOptions![0]!;
  expect(()=>decideContextPreparation({...input,receptionOptions:[option]})).toThrow("reception_binding_invalid");
});
it("rejects another recipient and cannot use a refused input to arrange in-request recovery",()=>{
  const {input,source}=fixture(),option=input.receptionOptions![0]!;
  expect(()=>decideContextPreparation({...input,receptionOptions:[{...option,sourceInput:{...source,scope:{...source.scope,runId:"child"}}}]})).toThrow("readiness_invalid");
  const unavailable=decideContextPreparation({...input,current:{...source,allowed:false},receptionOptions:[{...option,sourceInput:{...source,allowed:false}}]});
  expect(unavailable.investment.kind).not.toBe("prepare_input");
});
it("restores the existing arrangement responsibility without scheduling a second one",()=>{
  const {input}=fixture();
  const decision=decideContextPreparation({...input,inputReceptions:[{optionId:"arrangement",pathId:"arrangement",workId:"arrangement-work",
    state:"active",reason:null,evidence:{owner:"activity",kind:"fact",id:"arrangement",revision:"1"}}]});
  expect(decision.investment).toMatchObject({kind:"reuse_input",pathId:"arrangement",workId:"arrangement-work"});
});

import {describe,it,expect} from "vitest";
import {decideContextPreparation,type ContextPreparationPolicyInput,type ContextRecipientInputReadiness} from "@agent-anything/agent-runtime/context-representation";

const evidence=(id:string)=>({id,owner:"context-representation",revision:"1",kind:"fact" as const});
function fixture():ContextPreparationPolicyInput{
  const scope={id:"scope",runId:"root",owner:"context-representation",recipient:"task",purpose:"task",target:"config:1",authorityBasis:"host",continuity:"root"};
  const current:ContextRecipientInputReadiness={kind:"recipient_prepared",scope,inputId:"input",bodyDigest:"body",exactInputDigest:"exact",
    judgmentId:"judgment",allowed:true,risks:[],evidence:evidence("current")};
  return {scope,boundary:"source",requirementsDigest:"duties",current,currentRejectedInputId:null,alternatives:[],pressure:[],options:[],
    inFlight:[],explorationHistory:[],optionalInFlight:0,autoPrepare:true,consumerActive:true,
    receptionOptions:[{id:"receiver",members:[],sourceInput:current,beforeUse:true,addresses:["pressure"],comparisons:[],evidence:evidence("eligibility")}]};
}
describe("before-use recipient arrangement",()=>{
  it("requires a reason to invest and does not equate permission with selection",()=>{
    const input=fixture();expect(decideContextPreparation(input)).toMatchObject({foreground:{kind:"continue"},investment:{kind:"none"}});
    const pressure=[{kind:"input_capacity_risk" as const,inputId:"input",evidence:evidence("pressure")}];
    for(const revision of ["12","14","15"] as const)
      expect(decideContextPreparation({...input,pressure},revision)).toMatchObject({policy:{revision},foreground:{kind:"limited"},investment:{kind:"prepare_input",optionId:"receiver"}});
    expect(decideContextPreparation({...input,pressure,autoPrepare:false})).toMatchObject({foreground:{kind:"continue"},investment:{kind:"none"}});
  });
  it("waits for its own accepted receiver, not every background method",()=>{
    const input=fixture(),state={optionId:"receiver",workId:"work",pathId:"receiver",state:"active" as const,reason:null,evidence:evidence("working")};
    expect(decideContextPreparation({...input,inputReceptions:[state]})).toMatchObject({foreground:{kind:"needs_result",pathId:"receiver"},investment:{kind:"reuse_input"}});
    const {beforeUse:_beforeUse,...ordinary}=input.receptionOptions![0]!;
    expect(decideContextPreparation({...input,receptionOptions:[ordinary],inputReceptions:[state]}).foreground.kind).toBe("continue");
  });
  it("adopts a checked arrangement for the original pressure without fabricated savings",()=>{
    const input=fixture(),original=input.current as ContextRecipientInputReadiness;
    const checked={...original,inputId:"received",bodyDigest:"arranged",exactInputDigest:"arranged-exact",judgmentId:"received-judgment",evidence:evidence("checked")};
    const state={optionId:"receiver",pathId:"receiver",workId:"work",state:"checked" as const,reason:null,evidence:evidence("receiver"),
      outcomeEvidence:{...evidence("receiver:stage:1"),owner:"activity"},checkedInput:{inputId:checked.inputId,exactInputDigest:checked.exactInputDigest}};
    const basis={...input,inputReceptions:[state],alternatives:[{input:checked,comparisons:[]}],
      pressure:[{kind:"input_capacity_risk" as const,inputId:original.inputId,evidence:evidence("pressure")}]};
    expect(decideContextPreparation(basis).foreground).toMatchObject({kind:"continue",preparedInputId:checked.inputId,adoption:"propose"});
    expect(decideContextPreparation({...basis,pressure:[]}).foreground).toMatchObject({kind:"continue",preparedInputId:original.inputId});
    expect(()=>decideContextPreparation({...basis,inputReceptions:[{...state,checkedInput:{...state.checkedInput,exactInputDigest:"other"}}]})).toThrow("checked_reception_input_invalid");
  });
});

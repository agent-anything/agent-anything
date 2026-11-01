import {describe,it,expect,vi} from "vitest";
import {observeContextPreparationInput,readContextPreparationEvidence,contextPreparationCostEvidence,acceptedConversationRepresentationContinuity,type ContextPreparationObservationWindow} from "./ContextPreparationEvidence.js";
import type {PreparedContextInput} from "./ContextInputPreparation.js";
import type {ContextPreparationDecisionRecord} from "./ContextPreparationDecisionStore.js";

const scope={id:"scope",runId:"root",recipient:"agent",purpose:"task",target:"target",continuity:"task",owner:"context-representation",authorityBasis:"authority"};
const evidence=(id:string)=>({owner:"activity",kind:"fact" as const,id,revision:"1"});
function sample(sequence:number,value:number,previous:ContextPreparationObservationWindow|null=null) {
  const id=`input:${sequence}`;
  const prepared={encoded:{id},demand:{...scope,targetRevision:scope.target},measurement:[{id:`measure:${sequence}`,encodedInputId:id,targetRevision:scope.target,
    methodRevision:"wire-bytes:1",dimension:"request_bytes",coverage:"complete",quantity:{kind:"exact",value},basis:"Complete encoded body",uncovered:[]}],
    limits:[{id:"body-limit",targetRevision:scope.target,dimension:"request_bytes",maximum:1000,source:"host"}],capacity:{reservations:[]}} as unknown as PreparedContextInput;
  return {scope,settingsRevision:"fixed",sequence,observedAt:`2026-10-30T10:00:${String(sequence).padStart(2,"0")}.000Z`,
    representationContinuity:"original",prepared,evidence:evidence(`prepare:${sequence}`),previous};
}
describe("normal preparation evidence",()=>{
  it("observes accepted input revisions without inventing another task turn or growth sample",()=>{
    let previous:ContextPreparationObservationWindow|null=null;
    for(let sequence=0;sequence<3;sequence++)previous=observeContextPreparationInput(sample(sequence,500+sequence*150,previous)).report.window;
    const original=structuredClone(previous),revised=observeContextPreparationInput({...sample(2,850,previous),inputRevision:1});
    expect(revised.report.window.inputs).toHaveLength(3);expect(revised.pressure).toEqual([]);
    expect(previous).toEqual(original);expect(revised.report.window.inputs.at(-1)).toMatchObject({sequence:2,inputRevision:1});
    expect(observeContextPreparationInput({...sample(2,850,revised.report.window),inputRevision:1}).report.window).toEqual(revised.report.window);
    expect(()=>observeContextPreparationInput({...sample(2,851,revised.report.window),inputRevision:1})).toThrow("identity_changed");
    expect(()=>observeContextPreparationInput(sample(2,800,revised.report.window))).toThrow("revision_regressed");
    expect(()=>observeContextPreparationInput({...sample(1,650,revised.report.window),inputRevision:2})).toThrow("revision_regressed");
    expect(observeContextPreparationInput(sample(3,950,revised.report.window)).report.growth[0]?.deltas).toEqual([150,200,100]);
  });
  it("derives next-input risk from comparable growth, not a fullness percentage",()=>{
    let window:ContextPreparationObservationWindow|null=null;
    for(const [index,value] of [500,650,800,950].entries()) {
      const result=observeContextPreparationInput(sample(index,value,window));window=result.report.window;
      expect(result.pressure).toHaveLength(index===3?1:0);
      if(index===3)expect(result.report.growth[0]).toMatchObject({current:950,projectedNext:1100,deltas:[150,150,150]});
    }
    expect(observeContextPreparationInput(sample(0,990)).pressure).toEqual([]);
  });
  it("retains negative growth and does not pretend a decrease is steady positive growth",()=>{
    let window:ContextPreparationObservationWindow|null=null;
    for(const [index,value] of [100,400,350,750].entries()) {
      const result=observeContextPreparationInput(sample(index,value,window));window=result.report.window;
      if(index===3)expect(result.report.growth[0]?.deltas).toEqual([300,-50,400]);
    }
  });
  it.each(["measurement","continuity","sequence","partial"])("never bridges an incomparable %s sample",kind=>{
    let window:ContextPreparationObservationWindow|null=null;
    for(let i=0;i<4;i++) {
      const input=sample(kind==="sequence"&&i>=2?i+1:i,500+i*150,window);
      if(i===1) {
        if(kind==="continuity")input.representationContinuity="changed";
        if(kind==="measurement"||kind==="partial")Object.assign(input.prepared,{measurement:input.prepared.measurement.map(m=>kind==="partial"?{...m,coverage:"partial",uncovered:["media"]}:{...m,methodRevision:"other"})});
      }
      const result=observeContextPreparationInput(input);window=result.report.window;expect(result.pressure).toEqual([]);
    }
  });
  it("deduplicates recovery, rejects changed original evidence, and bounds retained samples",()=>{
    let window:ContextPreparationObservationWindow|null=null;
    for(let i=0;i<14;i++)window=observeContextPreparationInput(sample(i,100,window)).report.window;
    expect(window!.inputs).toHaveLength(8);
    expect(observeContextPreparationInput(sample(13,100,window)).report.window).toEqual(window);
    expect(()=>observeContextPreparationInput(sample(13,101,window))).toThrow("identity_changed");
    expect(()=>observeContextPreparationInput({...sample(14,100,window),scope:{...scope,runId:"child"}})).toThrow("scope_changed");
    expect(()=>observeContextPreparationInput({...sample(14,100,window),settingsRevision:"changed"})).toThrow("scope_changed");
  });
  it("keeps unknown reservations explicit without erasing supported lower-bound growth pressure",()=>{
    let window:ContextPreparationObservationWindow|null=null;
    for(let i=0;i<3;i++)window=observeContextPreparationInput(sample(i,500+i*150,window)).report.window;
    const input=sample(3,950,window);
    Object.assign(input.prepared,{capacity:{reservations:[{id:"future",dimension:"request_bytes",purpose:"future_growth",alreadyIncluded:false,quantity:{kind:"exact",value:400},basis:"scenario"}]}});
    expect(observeContextPreparationInput(input).report.growth[0]?.reserved).toBe(0);
    Object.assign(input.prepared,{capacity:{reservations:[{id:"output",dimension:"request_bytes",purpose:"generation",alreadyIncluded:false,quantity:{kind:"unknown",reason:"unknown"},basis:"unknown"}]}});
    const result=observeContextPreparationInput(input);
    expect(result.pressure).toMatchObject([{kind:"growth_scenario"}]);
    expect(result.report.growth[0]).toMatchObject({reserved:0,reservationComplete:false,unknownReservationIds:["output"],projectedNext:1100});
    expect(result.report.limitations).toContain("unknown_reservations_use_only_nonnegative_lower_bounds");
  });
  it("reports an existing estimated input risk without waiting for growth samples or inventing output space",()=>{
    const input=sample(0,1100);
    Object.assign(input.prepared,{measurement:[{...input.prepared.measurement[0],quantity:{kind:"estimate",value:1100,limitations:["unquantified"]}}],
      capacity:{reservations:[{id:"output",dimension:"request_bytes",purpose:"generation",alreadyIncluded:false,quantity:{kind:"unknown",reason:"unknown"},basis:"unknown"}]}});
    const result=observeContextPreparationInput(input);
    expect(result.report.growth).toEqual([]);
    expect(result.pressure).toMatchObject([{kind:"input_capacity_risk",evidence:{kind:"estimate"}}]);
    expect(result.report.capacityRisks).toMatchObject([{current:1100,maximum:1000,reservedMinimum:0,unknownReservationIds:["output"]}]);
    expect(input.prepared.measurement[0]!.quantity.kind).toBe("estimate");
  });
  it("restores the accepted evidence window and preserves failed producer consumption as partial cost",async()=>{
    const first=observeContextPreparationInput(sample(0,100)),used={stages:12,attempts:12,readBytes:100,storedBytes:50,modelCalls:2};
    const description={state:"failed",revision:12,used,remaining:{stages:8,attempts:8,readBytes:20,storedBytes:10,modelCalls:1},allowance:{limits:{modelCalls:3},reserved:{modelCalls:2}},limitations:["quality_gap"]} as unknown as Parameters<typeof contextPreparationCostEvidence>[1];
    const record={input:{scope,observationReport:first.report},investment:{workId:"work",pathId:"method",schedulingScopeId:"tree"}} as ContextPreparationDecisionRecord;
    const methods={describe:vi.fn(async()=>description)},decisions={query:vi.fn(async()=>record),investments:vi.fn(async()=>[record])},activities={command:vi.fn(async()=>[])};
    const result=await readContextPreparationEvidence({...sample(1,200),decisions,methods,activities},new AbortController().signal);
    expect(result.report.window.inputs).toHaveLength(2);
    expect(decisions.query).toHaveBeenCalledWith({kind:"latest_observation",scopeId:scope.id});
    expect(result.report.costs[0]).toMatchObject({state:"failed",confirmedProgress:{modelInputsPrepared:2,acceptedReadBytes:100},forecast:"unknown",reserved:{modelCalls:2},actual:{rawResults:0,reported:{}}});
    expect(result.report.costs[0]?.limitations).toContain("confirmed_consumption_is_not_remaining_cost");
    expect(methods.describe).toHaveBeenCalledWith("method");
    const aborted=new AbortController();aborted.abort(new Error("cancel"));
    await expect(readContextPreparationEvidence({...sample(1,200),decisions,methods,activities},aborted.signal)).rejects.toThrow("cancel");
  });
  it("restores prepared baselines across report-less decisions without inventing an adopted-candidate sample",async()=>{
    let latestObservation:ContextPreparationDecisionRecord|null=null;
    const decisions={query:vi.fn(async(query:{kind:string})=>query.kind==="latest_observation"?latestObservation:
      {input:{scope,current:{kind:"gap"},alternatives:[{input:{prepared:{encoded:{id:"adopted-alternative"}}}}]}}),investments:async()=>[]};
    const methods={describe:vi.fn()},activities={command:vi.fn()};
    for(const sequence of [1,2,4]) {
      const observed=await readContextPreparationEvidence({...sample(sequence,sequence*100),decisions:decisions as never,methods,activities},new AbortController().signal);
      latestObservation={input:{scope,observationReport:observed.report}} as ContextPreparationDecisionRecord;
    }
    expect(latestObservation!.input.observationReport!.window.inputs.map(i=>i.inputId)).toEqual(["input:1","input:2","input:4"]);
    expect(latestObservation!.input.observationReport!.growth).toEqual([]);
    expect(latestObservation!.input.observationReport!.limitations).toContain("prepared_input_is_not_delivery_or_billed_usage");
    expect(decisions.query.mock.calls.every(([query])=>query.kind==="latest_observation")).toBe(true);
  });
  it("rejects an observation query that returned a report-less decision",async()=>{
    const decisions={query:async()=>({input:{scope}} as ContextPreparationDecisionRecord),investments:async()=>[]};
    await expect(readContextPreparationEvidence({...sample(1,100),decisions,methods:{describe:vi.fn()},activities:{command:vi.fn()}},new AbortController().signal))
      .rejects.toThrow("observation_report_missing");
  });
  it("splits continuity only on accepted representation provenance, not ordinary growth or candidate text",()=>{
    const original={opening:null,historyPresentations:[],workingForms:[],workingAccounts:[]};
    expect(acceptedConversationRepresentationContinuity(original)).toBe("original");
    const plain={section:{id:"result",content:{kind:"text",text:"Derived representation"},provenance:{presenter:{owner:"agent-runtime",kind:"presenter",id:"history",revision:"1"}}}};
    expect(acceptedConversationRepresentationContinuity({...original,historyPresentations:[plain]} as never)).toBe("original");
    const accepted={...plain,section:{...plain.section,provenance:{presenter:{owner:"agent-runtime",kind:"result_presentation_receipt",id:"receipt-1",revision:"1"}}}};
    const history={...original,historyPresentations:[accepted]},continuity=acceptedConversationRepresentationContinuity(history as never);
    expect(continuity).toMatch(/^accepted-representations:/);
    expect(acceptedConversationRepresentationContinuity({...history,historyPresentations:[accepted,plain]} as never)).toBe(continuity);
    expect(acceptedConversationRepresentationContinuity({...history,historyPresentations:[{...accepted,section:{...accepted.section,
      provenance:{presenter:{...accepted.section.provenance.presenter,id:"receipt-2"}}}}]} as never)).not.toBe(continuity);
    expect(acceptedConversationRepresentationContinuity({...original,workingForms:[{id:"accepted-form"}]} as never)).not.toBe("original");
    expect(acceptedConversationRepresentationContinuity({...original,workingAccounts:[{id:"accepted-account"}]} as never)).not.toBe("original");
    let previous:ContextPreparationObservationWindow|null=null;
    for(let sequence=0;sequence<5;sequence++) {
      const observed=observeContextPreparationInput({...sample(sequence,200+sequence*180,previous),representationContinuity:sequence<2?"original":continuity});
      previous=observed.report.window;
      expect(observed.pressure).toEqual([]);
    }
    expect(previous!.inputs).toHaveLength(5);
  });
});

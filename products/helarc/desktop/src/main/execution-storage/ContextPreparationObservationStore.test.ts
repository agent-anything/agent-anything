import {afterEach,describe,expect,it,vi} from "vitest";
import {createRequire} from "node:module";
import type {DatabaseSync as SqliteDatabase} from "node:sqlite";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {observeContextPreparationInput,readContextPreparationEvidence,type ContextPreparationDecisionRecord,
  type ContextPreparationEvidenceReport,type PreparedContextInput} from "@agent-anything/agent-runtime/context-representation";
import type {SharedAcceptanceProposal} from "@agent-anything/agent-runtime/activity";
import {ContextFoundationRecords,CONTEXT_FOUNDATION_FACT_SCHEMA} from "./ContextFoundationRecords.js";
import {ContextPreparationDecisionDatabase,CONTEXT_PREPARATION_DECISION_SCHEMA} from "./ContextPreparationDecisionDatabase.js";

const {DatabaseSync}=createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const databases:SqliteDatabase[]=[];
afterEach(()=>{for(const db of databases.splice(0))db.close();});
const scope={id:"scope",runId:"root",recipient:"agent",purpose:"task",target:"target",continuity:"task",owner:"context-representation",authorityBasis:"host"};
function sample(sequence:number) {
  const id=`baseline:${sequence}`;
  return {scope,settingsRevision:"fixed",sequence,observedAt:`2026-10-31T00:00:${String(sequence).padStart(2,"0")}Z`,representationContinuity:"original",
    evidence:{id,owner:"activity",kind:"fact" as const,revision:"1"},prepared:{encoded:{id},demand:{...scope,targetRevision:scope.target},
      measurement:[],limits:[],capacity:{reservations:[]}} as unknown as PreparedContextInput};
}
function fixture() {
  const db=new DatabaseSync(":memory:");databases.push(db);db.exec(CONTEXT_FOUNDATION_FACT_SCHEMA+CONTEXT_PREPARATION_DECISION_SCHEMA);
  const records=new ContextFoundationRecords(db as never);
  const reopen=()=>new ContextPreparationDecisionDatabase(records,value=>({value}) as never,root=>(root as unknown as {value:unknown}).value,
    ()=>({scope,control:{revision:0,allowed:true}}) as never,()=>null,()=>true,()=>({}) as never,()=>true,()=>null,()=>null);
  const add=(id:string,report:ContextPreparationEvidenceReport|null,scopeId=scope.id,expectedDecisionId?:string|null)=>{
    const record={decision:{id,scope:{...scope,id:scopeId},investment:{kind:"none",reason:"fixture"},
      foreground:{kind:"limited",reason:"storage_fixture_without_consumer"},limitations:[],excluded:[]},input:{scope:{...scope,id:scopeId},
      current:{kind:report?"prepared":"gap",evidence:{id,owner:"activity",kind:"fact",revision:"1"}},
      ...(report?{observationReport:report}:{}),alternatives:[{input:{prepared:{encoded:{id:"independently-adopted-candidate"}}}}]},
      acceptanceId:`accept:${id}`,investment:null} as unknown as ContextPreparationDecisionRecord;
    const store=reopen(),proposal={input:record.input,investment:null,expectedControlRevision:0,
      expectedDecisionId:expectedDecisionId===undefined?store.query({kind:"latest",scopeId})?.decision.id??null:expectedDecisionId};
    // Exercise the owner's real transactional write path; policy choice is outside this storage fixture.
    db.exec("SAVEPOINT policy_write");
    try {
      store.participant().apply({proposal,record,root:{value:record},digest:modelInputValueDigest(record)},
        {id:record.acceptanceId,scope:scope.runId,actor:"context-representation",parts:[]} as SharedAcceptanceProposal);
      db.exec("RELEASE policy_write");
    } catch(error) {db.exec("ROLLBACK TO policy_write");db.exec("RELEASE policy_write");throw error;}
    return record;
  };
  return {db,records,reopen,add};
}
describe("durable preparation observation query",()=>{
  it("keeps observation recovery distinct from the latest gap, reception and adoption decision",async()=>{
    const f=fixture();
    expect(f.reopen().query({kind:"latest_observation",scopeId:scope.id})).toBeNull();
    let last:ContextPreparationEvidenceReport|null=null;
    for(const sequence of [1,2,5]) {
      const store=f.reopen();
      const observed=await readContextPreparationEvidence({...sample(sequence),decisions:{query:async q=>store.query(q),investments:async()=>[]},
        methods:{describe:async()=>{throw new Error("No method lookup expected");}},activities:{command:async()=>{throw new Error("No work expected");}}},new AbortController().signal);
      last=observed.report;f.add(`observed:${sequence}`,last);
      f.add(`gap:${sequence}`,null);f.add(`receiving:${sequence}`,null);f.add(`adoption:${sequence}`,null);
      expect(f.reopen().query({kind:"latest",scopeId:scope.id})?.decision.id).toBe(`adoption:${sequence}`);
      expect(f.reopen().query({kind:"latest_observation",scopeId:scope.id})?.decision.id).toBe(`observed:${sequence}`);
    }
    expect(last!.window.inputs.map(value=>value.inputId)).toEqual(["baseline:1","baseline:2","baseline:5"]);
    expect(last!.growth).toEqual([]);
    const foreign=observeContextPreparationInput({...sample(6),scope:{...scope,id:"other",recipient:"other-agent"},
      prepared:{...sample(6).prepared,demand:{...sample(6).prepared.demand,recipient:"other-agent"}},previous:null}).report;
    f.add("other-observation",foreign,"other");
    expect(f.reopen().query({kind:"latest_observation",scopeId:scope.id})?.decision.id).toBe("observed:5");
  });
  it("bounds the persisted window, deduplicates recovery and does not retain a rolled-back observation",async()=>{
    const f=fixture();let last:ContextPreparationEvidenceReport|null=null;
    for(let i=0;i<12;i++) {
      const store=f.reopen(),observed=await readContextPreparationEvidence({...sample(i),decisions:{query:async q=>store.query(q),investments:async()=>[]},
        methods:{describe:async()=>null as never},activities:{command:async()=>null}},new AbortController().signal);
      last=observed.report;f.add(`sample:${i}`,last);f.add(`no-observation:${i}`,null);
    }
    expect(last!.window.inputs).toHaveLength(8);
    expect(observeContextPreparationInput({...sample(11),previous:last!.window}).report.window).toEqual(last!.window);
    f.db.exec("BEGIN");f.add("rolled-back",observeContextPreparationInput({...sample(12),previous:last!.window}).report);f.db.exec("ROLLBACK");
    expect(f.reopen().query({kind:"latest_observation",scopeId:scope.id})?.decision.id).toBe("sample:11");
    expect(f.reopen().query({kind:"latest",scopeId:scope.id})?.decision.id).toBe("no-observation:11");
  });
  it("rejects a corrupt or missing authoritative observation instead of losing the window silently",()=>{
    const f=fixture(),report=observeContextPreparationInput({...sample(1),previous:null}).report;
    f.add("observation",report);
    f.add("gap",null);
    f.db.prepare("UPDATE context_policy_decisions SET digest='changed' WHERE id='observation'").run();
    expect(()=>f.reopen().query({kind:"latest_observation",scopeId:scope.id})).toThrow("context_policy_record_corrupt");
    f.db.prepare("DELETE FROM context_policy_decisions WHERE id='observation'").run();
    expect(()=>f.reopen().query({kind:"latest_observation",scopeId:scope.id})).toThrow("context_policy_observation_corrupt");
    f.db.prepare("UPDATE context_policy_observation_heads SET decision_id='gap'").run();
    expect(()=>f.reopen().query({kind:"latest_observation",scopeId:scope.id})).toThrow("context_policy_observation_corrupt");
  });
  it("uses two primary-key seeks with no history scan after many decisions without observations",()=>{
    const f=fixture();f.add("observation",observeContextPreparationInput({...sample(1),previous:null}).report);
    for(let i=0;i<2000;i++)f.add(`gap:${i}`,null);
    const queries:string[]=[],sql=f.records.sql.bind(f.records);
    vi.spyOn(f.records,"sql").mockImplementation(query=>{queries.push(query);return sql(query);});
    expect(f.reopen().query({kind:"latest_observation",scopeId:scope.id})?.decision.id).toBe("observation");
    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain("context_policy_observation_heads WHERE scope_id=?");
    expect(queries[1]).toContain("context_policy_decisions WHERE id=?");
    for(const [i,query] of queries.entries()) {
      const plan=f.db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(i===0?scope.id:"observation") as {detail:string}[];
      expect(plan).toHaveLength(1);
      expect(plan[0]!.detail).toMatch(/SEARCH .* USING INDEX sqlite_autoindex_context_policy_/);
      expect(plan[0]!.detail).not.toMatch(/SCAN|TEMP B-TREE/);
    }
  });
  it("does not move either head or append facts when the accepted policy head has changed",()=>{
    const f=fixture(),report=observeContextPreparationInput({...sample(1),previous:null}).report;
    f.add("observation",report);f.add("gap",null);
    const facts=f.records.facts(scope.runId,0,256);
    expect(()=>f.add("stale",report,scope.id,"observation")).toThrow("decision_head_conflict");
    expect(f.reopen().query({kind:"latest",scopeId:scope.id})?.decision.id).toBe("gap");
    expect(f.reopen().query({kind:"latest_observation",scopeId:scope.id})?.decision.id).toBe("observation");
    expect(f.reopen().query({kind:"decision",id:"stale"})).toBeNull();
    expect(f.records.facts(scope.runId,0,256)).toEqual(facts);
  });
});

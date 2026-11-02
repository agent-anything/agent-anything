import {createRequire} from "node:module";
import {afterEach,expect,it} from "vitest";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {contextProcessObject} from "@agent-anything/context/evidence";
import {ContextFoundationRecords,CONTEXT_FOUNDATION_FACT_SCHEMA} from "./ContextFoundationRecords.js";

const {DatabaseSync}=createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const opened:InstanceType<typeof DatabaseSync>[]=[];
afterEach(()=>{for(const db of opened.splice(0))db.close();});
function fixture(){
  const db=new DatabaseSync(":memory:");opened.push(db);db.exec(CONTEXT_FOUNDATION_FACT_SCHEMA);
  const records=new ContextFoundationRecords(db as never);
  const write=()=>records.fact("parent","context_selection","input","sent",{attemptId:"attempt"},
    {revision:"1",category:"selection",subject:contextProcessObject("context_selection","input","parent"),state:{phase:"pending",status:"sent"},relationships:[],related:[]});
  return {db,records,write};
}
it("does not expose rolled-back owner evidence and restores committed evidence exactly",()=>{
  const {db,records,write}=fixture();db.exec("SAVEPOINT acceptance");write();db.exec("ROLLBACK TO acceptance");db.exec("RELEASE acceptance");
  expect(records.takeObservations()).toEqual([]);expect(records.facts("parent",0,16)).toEqual([]);
  write();const observed=records.takeObservations();
  expect(observed).toHaveLength(1);expect(records.takeObservations()).toEqual([]);
  expect(new ContextFoundationRecords(db as never).facts("parent",0,16)).toEqual(observed);
});
it.each(["owner","subject","kind","run_id"])("rejects a fact whose %s index no longer matches its verified original value",field=>{
  const {db,records,write}=fixture();write();db.exec(`UPDATE context_foundation_facts SET ${field}='changed'`);
  expect(()=>records.takeObservations()).toThrow("context_fact_identity_corrupt");
});
it("retains content-digest validation even when the public evidence looks valid",()=>{
  const {db,records,write}=fixture();write();const fact=records.facts("parent",0,16)[0]!;
  db.prepare("UPDATE context_foundation_facts SET digest=?").run(modelInputValueDigest({...fact,details:{attemptId:"changed"}}));
  expect(()=>records.facts("parent",0,16)).toThrow("context_record_corrupt");
});

import {afterEach,describe,expect,it,vi} from "vitest";
import Database from "better-sqlite3";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {bindModelAgentComposition,OPENAI_RESPONSES} from "@agent-anything/model-interaction/protocol";
import {bindProtocolModelActivity,retainProtocolContent,readProtocolContent,type ProtocolEvidenceRevision,
  type ProtocolEvidenceScope,type ProtocolExecutionState} from "@agent-anything/agent-runtime/model-access";
import {ExecutionDatabase} from "./ExecutionDatabase.js";
import {PROTOCOL_EXECUTION_OBJECTS,PROTOCOL_RECONCILIATION_OBJECTS,PROTOCOL_ADMISSION_OBJECTS} from "./ProtocolExecutionDatabase.js";
import {PROTOCOL_EVIDENCE_OBJECTS,PROTOCOL_USAGE_ACCESS_OBJECTS} from "./ProtocolEvidenceDatabase.js";
import {MATERIAL_DELIVERY_OBJECTS,MATERIAL_DELIVERY_ACCESS_OBJECTS} from "./MaterialDeliveryDatabase.js";
import {CONTEXT_SELECTION_ACCESS_OBJECTS} from "./ContextSelectionDatabase.js";
import {HelarcExecutionStore} from "./HelarcExecutionStore.js";
import {admitComponentRun} from "../../../scripts/fixtures/admit-component-run.cjs";

const directories:string[]=[],databases:ExecutionDatabase[]=[],stores:HelarcExecutionStore[]=[];
afterEach(async()=>{
  vi.restoreAllMocks();
  for(const store of stores.splice(0))await store.close();
  for(const db of databases.splice(0))db.close();
  for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true});
});
function directory(){const path=mkdtempSync(join(tmpdir(),"protocol-evidence-storage-"));directories.push(path);return path;}
function open(path:string){const db=new ExecutionDatabase(path);databases.push(db);return db;}
function legacy(path:string,version:43|44|45|46|47|48|49){
  const store=open(path);
  store.contextPreparationCommand(store.generation,{kind:"open",intent:{id:"old",runId:"run",basis:"original",predecessor:null,deadlineAt:"2099-01-01T00:00:00Z",stages:["input"]}});
  store.contextPreparationCommand(store.generation,{kind:"write",id:"old",stage:"input",value:{text:"original retained input"}});store.close();
  const db=new Database(join(path,"execution.sqlite"));
  try {
    const objects=[...PROTOCOL_USAGE_ACCESS_OBJECTS,...MATERIAL_DELIVERY_ACCESS_OBJECTS,...CONTEXT_SELECTION_ACCESS_OBJECTS,"activity_reconsiderations_run",
      ...version<49?PROTOCOL_ADMISSION_OBJECTS:[],
      ...version<48?["execution_admission_fences","protocol_effects_activity","protocol_deliveries_activity"]:[],
      ...version<47?["run_tree_members_root"]:[],...version<46?PROTOCOL_RECONCILIATION_OBJECTS:[],
      ...version<45?PROTOCOL_EVIDENCE_OBJECTS:[],...version===43?[...PROTOCOL_EXECUTION_OBJECTS,...MATERIAL_DELIVERY_OBJECTS]:[]];
    const rows=objects.map(name=>({name,...db.prepare("SELECT type FROM sqlite_schema WHERE name=?").get(name) as {type:string}}));
    for(const row of rows.sort((a,b)=>a.type.localeCompare(b.type)))db.exec(`DROP ${row.type.toUpperCase()} ${row.name}`);
    db.prepare("UPDATE store SET version=?").run(version);
    return db.prepare("SELECT * FROM execution_content ORDER BY id").all();
  }finally{db.close();}
}
describe("Protocol evidence storage wiring",()=>{
  it.each([43,44,45,46,47,48,49] as const)("migrates format %i atomically without rewriting retained originals",version=>{
    const path=directory(),originals=legacy(path,version),migrated=open(path);
    expect(migrated.contextPreparationCommand(migrated.generation,{kind:"read",id:"old",stage:"input"})).toEqual({preparationValue:{text:"original retained input"}});
    migrated.close();const db=new Database(join(path,"execution.sqlite"));
    try{
      expect(db.prepare("SELECT version FROM store").get()).toEqual({version:50});
      expect(db.prepare("SELECT * FROM execution_content ORDER BY id").all()).toEqual(originals);
      expect(db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'protocol_evidence_%' ORDER BY name").all())
        .toHaveLength(PROTOCOL_EVIDENCE_OBJECTS.length+PROTOCOL_USAGE_ACCESS_OBJECTS.filter(name=>name.startsWith("protocol_evidence_")).length);
    }finally{db.close();}
  });
  it("rolls back an interrupted additive migration and rejects a changed index definition",()=>{
    const path=directory(),originals=legacy(path,44),exec=Database.prototype.exec;
    const failure=vi.spyOn(Database.prototype,"exec").mockImplementation(function(this:Database.Database,sql:string){
      if(sql.includes("CREATE TABLE protocol_evidence_scopes")){
        exec.call(this,sql.slice(0,sql.indexOf("CREATE TABLE protocol_evidence_activities")));
        throw new Error("interrupted_evidence_migration");
      }
      return exec.call(this,sql);
    });
    expect(()=>new ExecutionDatabase(path)).toThrow("interrupted_evidence_migration");failure.mockRestore();
    const db=new Database(join(path,"execution.sqlite"));
    try{
      expect(db.prepare("SELECT version FROM store").get()).toEqual({version:44});
      expect(db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'protocol_evidence_%'").all()).toEqual([]);
      expect(db.prepare("SELECT * FROM execution_content ORDER BY id").all()).toEqual(originals);
    }finally{db.close();}
    open(path).close();const changed=new Database(join(path,"execution.sqlite"));
    try{changed.exec("DROP INDEX protocol_evidence_membership_work; CREATE INDEX protocol_evidence_membership_work ON protocol_evidence_memberships(key,scope_id)");}
    finally{changed.close();}
    expect(()=>new ExecutionDatabase(path)).toThrow("execution_store_format_invalid");
  });
  it("round-trips immutable evidence, current slots, receipts and metadata pages through the actual Worker",async()=>{
    const path=directory(),worker=pathToFileURL(join(process.cwd(),process.env.HELARC_EXECUTION_TEST_BUILD??"dist","main/execution-storage/ExecutionStoreWorker.js"));
    const store=await HelarcExecutionStore.open(path,worker);stores.push(store);
    await admitComponentRun(store,path,"run");
    const ref=(id:string)=>({id,revision:"1"}),participant=(id:string)=>({implementation:ref(id),protocol:OPENAI_RESPONSES});
    const composition=bindModelAgentComposition({agent:ref("agent"),protocol:OPENAI_RESPONSES,
      configuration:{configuration:ref("configuration"),protocol:OPENAI_RESPONSES,model:"model",connectionBinding:ref("connection")},
      adapter:participant("adapter"),task:{purpose:ref("task"),interpreter:participant("interpreter"),input:participant("input")},auxiliary:[]});
    const activity=bindProtocolModelActivity({composition,scope:{runId:"run",activityId:"a",recipientId:"recipient",purpose:ref("task"),compositionDigest:composition.digest},
      conditions:{input:ref("input"),authority:ref("authority"),resources:ref("resources"),control:ref("control")}});
    const content=await retainProtocolContent(store.protocolJournal,"frozen","a",Buffer.from("original frozen native checkpoint"));
    const scope:ProtocolEvidenceScope={id:"scope",runId:"run",recipientId:"recipient",purpose:ref("task"),compositionDigest:composition.digest,owner:"adapter"};
    expect((await store.sharedAcceptance.accept({id:"prepare",scope:"run",actor:"execution-coordinator",parts:[
      {owner:"protocol_execution",kind:"prepare",proposal:{activity,input:content}},
      {owner:"protocol_execution",kind:"evidence_scope",proposal:{activityId:"a",scope}}]})).outcome).toBe("accepted");
    expect((await store.sharedAcceptance.accept({id:"claim",scope:"run",actor:"adapter",parts:[{owner:"protocol_execution",kind:"claim",proposal:{activityId:"a",expectedEpoch:0}}]})).outcome).toBe("accepted");
    const state=await store.protocolJournal.command({kind:"state",activityId:"a"}) as ProtocolExecutionState;
    const evidence:ProtocolEvidenceRevision={scopeId:scope.id,kind:"usage",key:"work",owner:"adapter",activityId:"a",revision:0,content,references:[],dependencies:[],metadata:{tokens:42},memberships:["run","tree"]};
    const proposal={id:"projection",scope:"run",actor:"adapter",parts:[{owner:"protocol_execution",kind:"evidence",proposal:{fence:state.fence,expectedRevision:null,evidence}}]};
    const receipt=await store.sharedAcceptance.accept(proposal);expect(receipt.outcome).toBe("accepted");
    await store.close();
    const reopened=await HelarcExecutionStore.open(path,worker);stores.push(reopened);
    expect(await reopened.sharedAcceptance.accept(proposal)).toEqual(receipt);
    expect(await reopened.protocolJournal.command({kind:"evidence_scope",activityId:"a",scopeId:scope.id})).toEqual(scope);
    expect(await reopened.protocolJournal.command({kind:"evidence",activityId:"a",scopeId:scope.id,evidenceKind:"usage",key:"work"})).toEqual(evidence);
    expect(await reopened.protocolJournal.command({kind:"evidence_list",activityId:"a",scopeId:scope.id,evidenceKind:"usage",membership:"tree",afterKey:null,limit:1})).toEqual({entries:[evidence],next:null,version:1});
    expect(await reopened.protocolJournal.command({kind:"usage_samples",runId:"run",recipientId:"recipient",purpose:ref("task"),compositionDigest:composition.digest,limit:1}))
      .toEqual({entries:[evidence],next:null,version:null});
    expect((await readProtocolContent(reopened.protocolJournal,content,"a",1024)).toString()).toBe("original frozen native checkpoint");
    const stale=await reopened.sharedAcceptance.accept({...proposal,id:"stale",parts:[{owner:"protocol_execution",kind:"evidence",proposal:{fence:state.fence,expectedRevision:0,evidence:{...evidence,revision:1}}}]});
    expect(stale.rejection?.code).toContain("fenced");
  },20000);
});

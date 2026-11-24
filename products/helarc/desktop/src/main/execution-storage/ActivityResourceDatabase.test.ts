import {afterEach,describe,expect,it} from "vitest";
import Database from "better-sqlite3";
import {ActivityPurposeRegistry,type ActivityPathIntent} from "@agent-anything/agent-runtime/activity";
import {ActivityResourceDatabase,ACTIVITY_RESOURCE_SCHEMA} from "./ActivityResourceDatabase.js";

const opened:Database.Database[]=[];
afterEach(()=>{for(const db of opened.splice(0))db.close();});
const registry=new ActivityPurposeRegistry<null>();
const purpose=registry.register({ref:{id:"input-reception",revision:"1"},inputOwner:"context",executionOwner:"context",
  interpretationOwner:"context",acceptanceOwner:"context",recoveryOwner:"context",stageKinds:["receive"],capabilities:[],continuationKinds:[]},null);
const original:ActivityPathIntent={id:"original",runId:"run",owner:"context",purpose,permissionBasis:"authority",resourceScope:"original",
  maximumStages:3,maximumAttempts:3,maximumConcurrent:1,deadlineAt:"2030-01-01T00:00:00Z",resourceLimits:{measurementCalls:2}};
function fixture(){
  const db=new Database(":memory:");opened.push(db);db.exec(ACTIVITY_RESOURCE_SCHEMA);
  const paths=new Map([[original.id,original]]),store=()=>new ActivityResourceDatabase(db,id=>paths.get(id)??null);
  const receiver=(id:string):ActivityPathIntent=>({...original,id,resourceScope:id,maximumStages:8,maximumAttempts:8,
    resourceLimits:{measurementCalls:2,readBytes:100},resourceBudgetSources:{measurementCalls:original.id}});
  const reserve=(resources:ActivityResourceDatabase,path:ActivityPathIntent,id:string,amounts:Record<string,number>)=>
    db.transaction(()=>resources.reserve(path,{id,pathId:path.id,requestId:`${path.id}:stage`,amounts}))();
  return {db,paths,store,receiver,reserve};
}
describe("accepted shared resource budgets",()=>{
  it("shares only declared dimensions and reuses reservations after reopening the owner",()=>{
    const f=fixture(),a=f.receiver("first"),b=f.receiver("replacement"),resources=f.store();
    resources.validate(a);resources.validate(b);
    f.reserve(resources,a,"count:1",{measurementCalls:1,readBytes:20});
    expect(resources.allowance(b)).toEqual({limits:{measurementCalls:2,readBytes:100},reserved:{measurementCalls:1}});
    const restored=f.store();f.reserve(restored,a,"count:1",{measurementCalls:1,readBytes:20});
    f.reserve(restored,b,"count:2",{measurementCalls:1});
    expect(restored.allowance(original).reserved.measurementCalls).toBe(2);
    expect(()=>f.reserve(restored,b,"count:3",{measurementCalls:1})).toThrow("activity_resource_limit_exceeded");
    expect(restored.allowance(a).reserved).toEqual({measurementCalls:2,readBytes:20});
  });
  it("does not enlarge a limit, cross owners or Runs, or follow another budget reference",()=>{
    const f=fixture(),a=f.receiver("first"),resources=f.store();
    for(const patch of [{runId:"child"},{owner:"other"},{permissionBasis:"new-authority"},{deadlineAt:"2031-01-01T00:00:00Z"},
      {resourceLimits:{measurementCalls:3}},{resourceScope:original.resourceScope}])expect(()=>resources.validate({...a,...patch})).toThrow("budget_source_invalid");
    f.paths.set("intermediate",{...a,id:"intermediate"});
    expect(()=>resources.validate({...a,resourceBudgetSources:{measurementCalls:"intermediate"}})).toThrow("budget_source_invalid");
  });
  it("retains no partial reservation when a later dimension exceeds its allowance",()=>{
    const f=fixture(),a=f.receiver("first"),resources=f.store();
    expect(()=>f.reserve(resources,a,"bad",{measurementCalls:1,readBytes:101})).toThrow("limit_exceeded");
    expect(resources.original("bad")).toBeNull();
    expect(resources.allowance(original).reserved).toEqual({});
  });
});

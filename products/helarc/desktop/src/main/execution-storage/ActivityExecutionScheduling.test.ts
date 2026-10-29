import {afterEach,describe,expect,it,vi} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {join,resolve,dirname,basename} from "node:path";
import {tmpdir} from "node:os";
import type {ProviderRequest,ProviderCallResult} from "@agent-anything/model-interaction";
import {ActivityHandoffProcessor,ActivityPurposeRegistry,type ActivityPurposeHandler,type ActivityHandoffCommand,type ActivityHandoffPort,type ActivityStageState,type ActivitySchedulingCandidate} from "@agent-anything/agent-runtime/activity";
import {createModelActivityBinding,ModelTransportJournal} from "@agent-anything/agent-runtime/model-access";
import {ExecutionDatabase} from "./ExecutionDatabase.js";

const roots:string[]=[],databases:ExecutionDatabase[]=[];
afterEach(()=>{for(const db of databases.splice(0))db.close();for(const root of roots.splice(0)){
  if(dirname(resolve(root))!==resolve(tmpdir())||!basename(root).startsWith("helarc-execution-scheduling-"))throw new Error("Unsafe cleanup");rmSync(root,{recursive:true,force:true});
}});
const now=()=>new Date().toISOString();
const deadline="2030-01-01T00:00:00Z";
const pool={id:"shared-model",revision:"1",authority:"test-host",capacity:1};
const result:ProviderCallResult={kind:"failed",failure:{category:"transport",code:"controlled_disconnect",message:"Connection dropped",metadata:{}}};
function open(directory=mkdtempSync(join(tmpdir(),"helarc-execution-scheduling-"))) {
  if(!roots.includes(directory))roots.push(directory);const db=new ExecutionDatabase(directory);databases.push(db);
  const send=(command:ActivityHandoffCommand)=>db.activityHandoffCommand(db.generation,command).activityValue;
  const port:ActivityHandoffPort={command:async command=>send(command)};
  const executor={hostSession:"test",worker:"test",generation:db.generation};
  return {db,directory,send,port,executor,journal:new ModelTransportJournal({port,executor,scheduling:{pool}},now)};
}
function exchange(runId:string,id=runId) {
  // This unit exercises retained transport identity; full request encoding is tested by Electron fixtures.
  const request={requestId:id,composition:{providerId:"controlled",model:"controlled"}} as ProviderRequest;
  const activity=createModelActivityBinding({runId,activityId:`${id}:decision`,purpose:"task",owner:{kind:"task_decision",inputOwner:"context_representation"}});
  return {request,activity};
}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return {promise,resolve};}

describe("shared physical execution",()=>{
  it("settles an expired queue admission without pretending transport was started",async()=>{
    const f=open(),x=exchange("root"),send=vi.fn(async()=>result);
    const journal=new ModelTransportJournal({port:f.port,executor:f.executor,scheduling:{pool}},()=>"2031-01-01T00:00:00Z");
    await expect(journal.execute(x.request,x.activity,"expired",deadline,new AbortController().signal,send)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    const facts=f.send({kind:"facts",runId:"root",after:0,limit:256}) as readonly {kind:string;pathId:string}[];
    expect(facts.some(fact=>fact.kind==="dispatched")).toBe(false);
    const pathId=facts.find(fact=>fact.kind==="path_opened")!.pathId;
    expect(f.send({kind:"read_path",pathId})).toMatchObject({cancelled:true});
  });
  it("does not let one denied stage block independent work in the same Run",async()=>{
    const f=open(),registry=new ActivityPurposeRegistry<ActivityPurposeHandler>(),started:string[]=[];
    const purpose=registry.register({ref:{id:"authorization-test",revision:"1"},inputOwner:"method",executionOwner:"test",interpretationOwner:"method",acceptanceOwner:"method",recoveryOwner:"method",stageKinds:["work"],capabilities:[],continuationKinds:[]},{
      authorize:async path=>{if(path.intent.id==="denied")throw new Error("current authority withdrawn");},reconcile:async()=>null,
      execute:async(path,_stage,attempt)=>{started.push(path.intent.id);return {id:`${attempt.id}:raw`,attemptId:attempt.id,completeness:"complete",outcome:"returned",value:"done",usage:null,recordedAt:now()};},
      interpret:async()=>({progress:{done:true},next:[]})
    });
    for(const id of ["denied","allowed"]){
      f.send({kind:"open_path",intent:{id,runId:"root",owner:"method",purpose,permissionBasis:"test",resourceScope:id,maximumStages:1,maximumAttempts:1,maximumConcurrent:1,deadlineAt:deadline}});
      f.send({kind:"submit",request:{id:`${id}:stage`,pathId:id,stageKind:"work",input:id,capabilities:[],dependencies:[]}});
    }
    const processor=new ActivityHandoffProcessor(f.port,registry,f.executor,now),signal=new AbortController().signal;
    const first=await processor.scan("root",signal);expect(first.failures).toHaveLength(1);
    await processor.scan("root",signal);await processor.settled();expect(started).toEqual(["allowed"]);
    expect(f.send({kind:"read_stage",requestId:"denied:stage"})).toMatchObject({dispatchRestriction:{code:"authorization_not_established"},attempt:null});
  });
  it("releases physical occupancy before transport retry backoff, and restores the original result",async()=>{
    const first=open(),root=exchange("root"),child=exchange("child"),send=vi.fn(async()=>result),signal=new AbortController().signal;
    await first.journal.execute(root.request,root.activity,"attempt:1",deadline,signal,send);
    // The logical root request is still open, but a Child may use the physical pool.
    await first.journal.execute(child.request,child.activity,"child:1",deadline,signal,send);
    first.db.close();const restored=open(first.directory);
    expect(await restored.journal.restore(root.request,root.activity,"attempt:1")).toEqual(result);
    await restored.journal.execute(root.request,root.activity,"attempt:1",deadline,signal,send);
    expect(send).toHaveBeenCalledTimes(2);
    await restored.journal.execute(root.request,root.activity,"attempt:2",deadline,signal,send);
    expect(send).toHaveBeenCalledTimes(3);
  });
  it("resumes a retained admission without a dispatch, but never replays an unknown dispatch",async()=>{
    const first=open(),x=exchange("root"),signal=new AbortController().signal;
    const original=first.port.command;
    const cutPort:ActivityHandoffPort={command:command=>{
      if(command.kind==="dispatch")throw new Error("simulate process loss before dispatch");return original(command);
    }};
    const interrupted=new ModelTransportJournal({port:cutPort,executor:first.executor,scheduling:{pool}},now);
    const send=vi.fn(async()=>result);
    await expect(interrupted.execute(x.request,x.activity,"attempt:1",deadline,signal,send)).rejects.toThrow();
    first.db.close();const recovered=open(first.directory);
    expect(await recovered.journal.restore(x.request,x.activity,"attempt:1")).toBeNull();
    await recovered.journal.execute(x.request,x.activity,"attempt:1",deadline,signal,send);
    expect(send).toHaveBeenCalledTimes(1);
    const unknown=exchange("child");
    await expect(recovered.journal.execute(unknown.request,unknown.activity,"attempt:unknown",deadline,signal,async()=>{throw new Error("lost response");})).rejects.toThrow();
    await expect(recovered.journal.restore(unknown.request,unknown.activity,"attempt:unknown")).rejects.toThrow();
    await expect(recovered.journal.execute(unknown.request,unknown.activity,"attempt:unknown",deadline,signal,send)).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("does not release occupancy after unconfirmed cancellation",async()=>{
    const f=open(),x=exchange("root"),signal=new AbortController().signal;
    const unconfirmed:ProviderCallResult={kind:"cancellation_unconfirmed",failure:{category:"cancellation",code:"unconfirmed",message:"No confirmation",metadata:{}}};
    expect(await f.journal.execute(x.request,x.activity,"attempt:1",deadline,signal,async()=>unconfirmed)).toEqual(unconfirmed);
    await expect(f.journal.restore(x.request,x.activity,"attempt:1")).rejects.toThrow();
    const other=exchange("child"),cancel=new AbortController(),send=vi.fn(async()=>result);
    const waiting=f.journal.execute(other.request,other.activity,"attempt:2",deadline,cancel.signal,send);
    const rejected=expect(waiting).rejects.toThrow("cancel waiting");
    await vi.waitFor(()=>expect((f.send({kind:"scheduling_candidates",limit:10}) as readonly ActivitySchedulingCandidate[])).toEqual([]));
    cancel.abort(new Error("cancel waiting"));await rejected;expect(send).not.toHaveBeenCalled();
  });
  it("keeps generation and assessment as stages of one original preparation",async()=>{
    const f=open(),signal=new AbortController().signal,request=exchange("root").request;
    for(const kind of ["context_generation","context_assessment"] as const){
      const activity=createModelActivityBinding({runId:"root",activityId:"original-preparation",purpose:kind,owner:{kind,inputOwner:"activity"}});
      await f.journal.execute({...request,requestId:kind},activity,kind,deadline,signal,async()=>result);
    }
    expect(f.send({kind:"read_schedule",workId:"auxiliary-work:root:original-preparation"})).toMatchObject({revision:1,intent:{owner:"context-representation"}});
  });
  it("scans a second Run while the first external stage remains in flight and retains late results",async()=>{
    const f=open(),registry=new ActivityPurposeRegistry<ActivityPurposeHandler>(),started:string[]=[],slow=deferred<void>();
    const signals=new Map<string,AbortSignal>();
    const purpose=registry.register({ref:{id:"method",revision:"1"},inputOwner:"method",executionOwner:"test",interpretationOwner:"method",acceptanceOwner:"method",recoveryOwner:"method",stageKinds:["work"],capabilities:[],continuationKinds:[]},{
      authorize:async()=>{},reconcile:async()=>{throw new Error("in-flight work must not be reconciled by its own processor");},
      execute:async(path,stage,attempt,signal)=>{signals.set(path.intent.runId,signal);started.push(path.intent.runId);if(path.intent.runId==="root")await slow.promise;return {id:`${attempt.id}:raw`,attemptId:attempt.id,completeness:"complete",outcome:"returned",value:stage.request.input,usage:null,recordedAt:now()};},
      interpret:async()=>({progress:{done:true},next:[]})
    });
    for(const runId of ["root","child"]){f.send({kind:"open_path",intent:{id:runId,runId,owner:"method",purpose,permissionBasis:"test",resourceScope:runId,maximumStages:1,maximumAttempts:1,maximumConcurrent:1,deadlineAt:deadline}});
      f.send({kind:"submit",request:{id:`${runId}:stage`,pathId:runId,stageKind:"work",input:{runId},capabilities:[],dependencies:[]}});
      f.send({kind:"admit",requestId:`${runId}:stage`,expectedControlRevision:0});}
    const processor=new ActivityHandoffProcessor(f.port,registry,f.executor,now),signal=new AbortController().signal;
    try {
      await processor.scan("root",signal);await processor.scan("child",signal);
      expect(started).toEqual(["root","child"]);
      await processor.scan("root",signal);
      f.send({kind:"cancel",pathId:"root",expectedControlRevision:0});
      await processor.scan("root",signal);expect(signals.get("root")?.aborted).toBe(true);expect(signals.get("child")?.aborted).toBe(false);
      slow.resolve();await processor.settled();
      expect(f.send({kind:"read_stage",requestId:"root:stage"})).toMatchObject({result:{value:{runId:"root"}}});
      expect(started).toHaveLength(2);
      await processor.scan("child",signal);
      expect((f.send({kind:"read_stage",requestId:"child:stage"}) as ActivityStageState).receipt).not.toBeNull();
    } finally {slow.resolve();await processor.settled();}
  });
});

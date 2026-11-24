import {afterEach,describe,expect,it,vi} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,dirname,resolve,basename} from "node:path";
import {ActivityHandoffProcessor,ActivityPurposeRegistry,type ActivityPurposeHandler,type ActivityHandoffPort,
  type SharedAcceptancePort,type ActivityStageState} from "@agent-anything/agent-runtime/activity";
import {bindProtocolModelActivity,type ProtocolExecutionJournal} from "@agent-anything/agent-runtime/model-access";
import {bindModelAgentComposition,OPENAI_RESPONSES} from "@agent-anything/model-interaction/protocol";
import {OPENAI_RESPONSES_ADAPTER} from "@agent-anything/provider-integrations/native";
import {prepareHelarcResponsesStructured,HELARC_NATIVE_STRUCTURED_INTERPRETER,type HelarcNativeStructuredInputPolicy} from "@agent-anything/helarc/controller";
import {HelarcNativeAuxiliaryInputPreparation} from "./HelarcNativeAuxiliaryInputPreparation.js";
import type {HelarcResponsesInputMeasurements} from "./HelarcResponsesInputMeasurement.js";
import {ExecutionDatabase} from "../execution-storage/ExecutionDatabase.js";
import type {HelarcExecutionStore} from "../execution-storage/HelarcExecutionStore.js";

const directories:string[]=[],databases:ExecutionDatabase[]=[],controllers:AbortController[]=[],pendingWork:Promise<unknown>[]=[];
afterEach(async()=>{
  for(const controller of controllers.splice(0))controller.abort(new Error("fixture cleanup"));
  await Promise.allSettled(pendingWork.splice(0));
  for(const db of databases.splice(0))db.close();
  for(const directory of directories.splice(0)){
    if(dirname(resolve(directory))!==resolve(tmpdir())||!basename(directory).startsWith("helarc-auxiliary-input-"))throw new Error("Unsafe cleanup");
    rmSync(directory,{recursive:true,force:true});
  }
});
const ref=(id:string)=>({id,revision:"1"}),participant=(id:string)=>({implementation:ref(id),protocol:OPENAI_RESPONSES});
const purpose=ref("helarc.task-fulfillment");
const composition=bindModelAgentComposition({agent:ref("agent"),protocol:OPENAI_RESPONSES,
  configuration:{configuration:ref("configuration"),protocol:OPENAI_RESPONSES,model:"model",connectionBinding:ref("connection")},
  adapter:{implementation:OPENAI_RESPONSES_ADAPTER,protocol:OPENAI_RESPONSES},
  task:{purpose:ref("task"),interpreter:participant("task-interpreter"),input:participant("task-input")},
  auxiliary:[{purpose,input:participant("auxiliary-input"),interpreter:{implementation:HELARC_NATIVE_STRUCTURED_INTERPRETER,protocol:OPENAI_RESPONSES}}]});
function request(runId="root"){
  const activity=bindProtocolModelActivity({composition,scope:{runId,activityId:`${runId}:evaluation`,recipientId:"agent",purpose,compositionDigest:composition.digest},
    conditions:{input:ref("input"),authority:ref("authority"),resources:ref("resources"),control:ref("control")}});
  return prepareHelarcResponsesStructured({activity,source:ref(`${runId}:source`)},{stream:false,store:false,input:[{role:"user",content:"Original complete evidence"}],
    textSchema:{type:"object",properties:{allowed:{type:"boolean"}},required:["allowed"],additionalProperties:false}});
}
const capacity:HelarcNativeStructuredInputPolicy={limits:[],reservations:[],policy:{id:"original-capacity",revision:"1",purpose:purpose.id,
  basis:"Original policy",allowUnknown:true,allowEstimatedFit:true}};
function open(directory=mkdtempSync(join(tmpdir(),"helarc-auxiliary-input-"))){
  if(!directories.includes(directory))directories.push(directory);
  const db=new ExecutionDatabase(directory);databases.push(db);
  const controller=new AbortController();controllers.push(controller);
  const track=<T>(promise:Promise<T>)=>{pendingWork.push(promise);void promise.catch(()=>{});return promise;};
  const activityHandoffs:ActivityHandoffPort={command:async c=>db.activityHandoffCommand(db.generation,c).activityValue};
  const protocolJournal:ProtocolExecutionJournal={command:async c=>db.protocolJournalCommand(db.generation,c).protocolJournalValue};
  let submitted!:()=>void;const submission=new Promise<void>(resolve=>{submitted=resolve;});
  const sharedAcceptance:SharedAcceptancePort={query:async id=>db.querySharedAcceptance(db.generation,id),accept:async proposal=>{
    const result=db.acceptShared(db.generation,proposal).acceptanceValue;
    if(proposal.parts.some(p=>p.kind==="stage_submission"))submitted();return result;
  }};
  const registry=new ActivityPurposeRegistry<ActivityPurposeHandler>();
  const measureStructured=vi.fn<HelarcResponsesInputMeasurements["measureStructured"]>(async()=>({evidence:[],usage:{measurementCalls:0}}));
  const interruptStructured=vi.fn<HelarcResponsesInputMeasurements["interruptStructured"]>(async()=>{});
  const arrangement=vi.fn(async()=>({permissionBasis:"authority",scopeId:"tree",modelPoolId:"model-pool",deadlineAt:"2099-01-01T00:00:00Z",maximumMeasurements:2}));
  const store={activityHandoffs,protocolJournal,sharedAcceptance} as HelarcExecutionStore;
  const work=new HelarcNativeAuxiliaryInputPreparation({store,registry,measurement:{measureStructured,interruptStructured},
    authorize:async()=>({kind:"allowed"}),now:()=>new Date().toISOString(),arrangement,
    host:{assertAvailable(){},wake(){},subscribe:()=>()=>{}}});
  const processor=new ActivityHandoffProcessor(activityHandoffs,registry,{hostSession:"test",worker:`test:${db.generation}`,generation:db.generation},()=>new Date().toISOString());
  return {directory,db,work,processor,activityHandoffs,protocolJournal,arrangement,measureStructured,interruptStructured,submission,controller,track};
}
async function pump(f:ReturnType<typeof open>,runId="root"){
  const deadline=performance.now()+4000;
  for(;;){
    const cycle=await f.processor.drain(runId,f.controller.signal);
    expect(cycle.failures).toEqual([]);
    const stage=await f.activityHandoffs.command({kind:"read_stage",requestId:`${runId}:evaluation:input-preparation:prepare`}) as ActivityStageState|null;
    if(stage&&["accepted","settled","stopped"].includes(stage.status))return;
    if(performance.now()>=deadline)throw new Error(`Auxiliary preparation did not settle: ${JSON.stringify(stage)}`);
  }
}
describe("Native auxiliary input preparation",()=>{
  it("accepts an input assessment without accepting generation and restores the original result without counting again",async()=>{
    const f=open(),r=request();
    await f.activityHandoffs.command({kind:"bind_resource_pool",pool:{id:"model-pool",revision:"1",authority:"host",capacity:1}});
    const prepared=f.track(f.work.prepare(r,capacity,f.controller.signal));
    await f.submission;await pump(f);const result=await prepared;
    expect(result.wire).toEqual(r.wire);
    expect(result.inputPreparation?.assessment.allowed).toBe(true);
    expect(f.measureStructured).toHaveBeenCalledTimes(1);
    expect(f.measureStructured.mock.calls[0]?.[1].measurement).toEqual({kind:"auxiliary_input",pathId:"root:evaluation:input-preparation",
      stageId:"root:evaluation:input-preparation:prepare",maximumCalls:2});
    expect(await f.protocolJournal.command({kind:"state",activityId:r.activity.scope.activityId})).toBeNull();
    f.db.close();const restored=open(f.directory);
    expect(await restored.track(restored.work.restore(r.activity.scope.activityId,r.source,restored.controller.signal))).toEqual(result);
    expect(restored.measureStructured).not.toHaveBeenCalled();expect(restored.arrangement).not.toHaveBeenCalled();
    await expect(restored.work.restore(r.activity.scope.activityId,ref("different-source"),new AbortController().signal))
      .rejects.toThrow("native_auxiliary_input_restore_changed");
  });
  it("cancels the accepted preparation before any generation and does not run the count",async()=>{
    const f=open(),r=request(),abort=new AbortController();
    await f.activityHandoffs.command({kind:"bind_resource_pool",pool:{id:"model-pool",revision:"1",authority:"host",capacity:1}});
    const prepared=f.track(f.work.prepare(r,capacity,AbortSignal.any([abort.signal,f.controller.signal])));
    const rejected=expect(prepared).rejects.toThrow();
    await f.submission;abort.abort(new Error("test interruption"));await rejected;
    await f.work.interrupt(r.activity.scope.activityId,r.source,f.controller.signal);
    expect((await f.processor.drain("root",f.controller.signal)).failures).toEqual([]);
    expect(await f.activityHandoffs.command({kind:"scheduled_settlement",workId:"root:evaluation:input-preparation"})).toMatchObject({remaining:null});
    expect(await f.activityHandoffs.command({kind:"read_stage",requestId:"root:evaluation:input-preparation:prepare"})).toMatchObject({attempt:null,result:null});
    expect(f.measureStructured).not.toHaveBeenCalled();expect(f.interruptStructured).toHaveBeenCalled();
    expect(await f.protocolJournal.command({kind:"state",activityId:r.activity.scope.activityId})).toBeNull();
    await expect(f.work.restore(r.activity.scope.activityId,r.source,new AbortController().signal)).rejects.toThrow("native_auxiliary_input_cancelled");
  });
  it("keeps a measured capacity failure as evidence, not permission or an allow Hook result",async()=>{
    const f=open(),r=request();
    f.measureStructured.mockImplementation(async request=>({usage:{measurementCalls:1},evidence:[{
      id:"count",encodedInputId:`${request.activity.scope.activityId}:native-input:${request.wire.digest}`,targetRevision:"configuration:1",
      methodRevision:"fixture-count:1",dimension:"shared_tokens",coverage:"complete",quantity:{kind:"exact",value:1000},basis:"Controlled count",uncovered:[]}]}));
    await f.activityHandoffs.command({kind:"bind_resource_pool",pool:{id:"model-pool",revision:"1",authority:"host",capacity:1}});
    const pending=f.track(f.work.prepare(r,{...capacity,limits:[{id:"window",targetRevision:"configuration:1",dimension:"shared_tokens",maximum:100,source:"Original limit"}]},f.controller.signal));
    await f.submission;await pump(f);const prepared=await pending;
    expect(prepared.inputPreparation?.assessment.allowed).toBe(false);
    const stage=await f.activityHandoffs.command({kind:"read_stage",requestId:"root:evaluation:input-preparation:prepare"}) as ActivityStageState;
    expect(stage.result?.usage).toMatchObject({measurementCalls:1});
    expect(await f.protocolJournal.command({kind:"state",activityId:r.activity.scope.activityId})).toBeNull();
  });
});

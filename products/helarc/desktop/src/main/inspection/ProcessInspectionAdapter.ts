import {createHash} from "node:crypto";
import {createExecutionFlowDefinition, ExecutionFlowPath, type ExecutionFlowContext} from "@agent-anything/observability/execution-flow";
import type {InspectionRecorder} from "@agent-anything/inspection/recording";
import type {InspectionContentInput, InspectionJson, InspectionLink, InspectionPayload, InspectionSubjectRef} from "@agent-anything/inspection/records";
import type {ProcessExecutionFact, ProcessSnapshot} from "@agent-anything/helarc-local-environment/command";

const states = ["starting","running","stopping","draining","settled","unresolved"];
const transitions = [
  ["starting","running"],["starting","stopping"],["starting","draining"],["starting","unresolved"],
  ["running","stopping"],["running","draining"],["running","unresolved"],
  ["stopping","draining"],["stopping","unresolved"],["draining","settled"],["draining","unresolved"],
  ["unresolved","draining"],["unresolved","stopping"],["unresolved","settled"],
] as const;
const steps = ["reserved","launching","started","root_exit","termination_requested","scope_empty","output_settled","settled","unresolved"] as const;
const processFlow = createExecutionFlowDefinition({owner:"helarc-command",id:"process-lifetime",revision:"1",label:"Managed process lifetime",
  description:"Run-owned process facts, independent of startup and observation invocation lifetimes.",
  steps:steps.map(id=>({id,label:id.replaceAll("_"," "),kind:id === "reserved" ? "entry" as const:id === "settled" ? "exit" as const:"process" as const,
    checks:id === "scope_empty" ? ["containment_empty"]:id === "settled" ? ["output_persisted"]:[]})),
  // Backend fact order is not a workflow dependency. Transitions enumerate diagnostic paths only.
  transitions:steps.flatMap(from=>steps.filter(to=>to!==from && to!=="reserved").map(to=>({id:`${from}:${to}`,from,to,label:to.replaceAll("_"," ")}))),
  entryStepIds:["reserved"],exitStepIds:["settled"],
});
const observationFlow = createExecutionFlowDefinition({owner:"helarc-command",id:"process-observation",revision:"1",label:"Bounded process observation",
  description:"Read retained output or wait for a process fact; this invocation does not own the process.",
  steps:[{id:"wait",label:"Observe owned process",kind:"entry",checks:["run_identity","cursor_valid","wait_bound"]},
    {id:"return",label:"Return immutable observation",kind:"exit",checks:[]}],
  transitions:[{id:"wait:return",from:"wait",to:"return",label:"Observation returned"}],entryStepIds:["wait"],exitStepIds:["return"],
});

/** Product mapping of immutable command facts. No process control or live file reads. */
export class ProcessInspectionAdapter {
  private readonly phases = new Map<string,string>();
  private readonly processFlows = new Map<string,ExecutionFlowPath>();
  private readonly observationFlows = new Map<string,ExecutionFlowPath>();
  private occurredAt = "";
  constructor(private readonly recorder:InspectionRecorder,private readonly flow:ExecutionFlowContext) {}

  observe = (fact:ProcessExecutionFact):void => {
    this.occurredAt = fact.occurredAt;
    const s=fact.snapshot, r=this.recorder;
    const ref=(kind:InspectionSubjectRef["kind"],id:string,revision:string|null=null,owner="helarc-command")=>r.ref(owner,kind,id,s.ref.runId,revision);
    const process=ref("process",s.ref.executionId);
    const run=ref("run",s.ref.runId,null,"runtime");
    const event=ref("event",`${s.ref.executionId}:fact:${fact.sequence}`);
    const recordId=`process:${createHash("sha256").update(s.ref.executionId).digest("hex")}:${fact.sequence}`;
    const offer=(subject:InspectionSubjectRef,payload:InspectionPayload,contents:InspectionContentInput[]=[],links:Link[]=[],id?:string)=>r.offer({
      ...(id ? {id}:{}),subject,payload,contents,links,occurredAt:fact.occurredAt,ownerSequence:fact.sequence,
    });
    const eventLinks:Link[]=[link("contains",process,event)];
    if(fact.requestId) eventLinks.push(link("trigger",ref("action",fact.requestId,null,"action-execution"),event));
    offer(event,{kind:"event",name:`process.${fact.kind}`,sequence:fact.sequence,code:fact.cleanupConfirmed === false ? "process_cleanup_unconfirmed":null},
      [content("Process fact",fact,"owner_fact")],eventLinks,recordId);
    if(fact.kind === "retention_expired") {this.phases.delete(s.ref.executionId);return;}
    const links:Link[]=[link("contains",run,process)];
    if(fact.kind === "reserved") {
      links.push(link("spawn",ref("action",s.actionId,null,"action-execution"),process));
      if(s.origin) links.push(link("spawn",ref("attempt",`${s.actionId}:${s.origin.attemptId}`,null,"action-execution"),process),
        link("spawn",ref("operation",s.origin.invocationId,null,"operations"),process));
      offer(process,{kind:"lifecycle",revision:"1",states,transitions:transitions.map(([from,to])=>({id:`${from}:${to}`,from,to,trigger:"Committed process fact"}))});
      const flow=new ExecutionFlowPath(processFlow,this.flow,s.ref.runId,[flowRef(process)],()=>this.occurredAt);
      this.processFlows.set(s.ref.executionId,flow);
    }
    const previous=this.phases.get(s.ref.executionId) ?? null;
    if(previous!==s.phase) offer(process,{kind:"transition",from:previous,to:s.phase,revision:s.revision,
      transitionId:previous ? `${previous}:${s.phase}`:null,reasonCode:fact.kind},[],[link("trigger",event,process)]);
    this.phases.set(s.ref.executionId,s.phase);
    offer(process,processPayload(s),[content("Process snapshot",s,"committed")],links);

    const interval=(subject:InspectionSubjectRef,activity:"process"|"process-output"|"wait",phase:"started"|"settled",status:string|null)=>
      offer(subject,{kind:"interval",phase,activity,status,clock:r.manifest.producerInstanceId});
    if(fact.kind === "started") interval(process,"process","started",null);
    if(fact.kind === "scope_empty" && s.startedAt!==null) {interval(process,"process","settled","empty");interval(process,"process-output","started",null);}
    if(fact.kind === "output_settled" && s.startedAt!==null) interval(process,"process-output","settled",s.output.persistence);
    const lifetime=this.processFlows.get(s.ref.executionId);
    if(lifetime && (steps as readonly string[]).includes(fact.kind)) {
      const step=lifetime.advance(fact.kind,{phase:s.phase,revision:s.revision},[flowRef(event)]);
      if(fact.kind === "scope_empty")step.check("containment_empty",s.containment.disposition === "empty" ? "passed":"not_satisfied");
      if(fact.kind === "settled") {step.check("output_persisted",s.output.persistence === "complete" ? "passed":"error");lifetime.close("returned",undefined,[flowRef(process)]);this.processFlows.delete(s.ref.executionId);}
    }
    if(fact.kind === "finalized") {
      offer(ref("contribution",`${s.ref.executionId}:cleanup`,String(fact.sequence)),{kind:"event",name:"process.cleanup",sequence:fact.sequence,
        code:fact.cleanupConfirmed ? null:"process_cleanup_unconfirmed"},[content("Cleanup outcome",{confirmed:fact.cleanupConfirmed,snapshot:s},"finalized")],
        [link("binding",process,run)]);
    }
    if(!fact.observationId || !fact.invocationId)return;
    const observation=ref("process-observation",fact.observationId,"1");
    const invocation=ref("operation",fact.invocationId,null,"operations");
    const value=fact.observation;
    const disposition=fact.kind === "observation_started" ? "started":fact.kind === "observation_cancelled" ? "cancelled":"returned";
    const observationLinks=[link("produces",invocation,observation),link("contains",process,observation)];
    if(value) {
      const exact=ref("process",s.ref.executionId,String(s.revision));
      offer(exact,processPayload(s),[content("Observed process snapshot",s,"observed")],[link("binding",process,exact)]);
      observationLinks.push(link("observes",observation,exact));
    }
    const observationRecordId=`${recordId}:observation`;
    offer(observation,{kind:"process_observation",executionId:s.ref.executionId,invocationId:fact.invocationId,snapshotRevision:s.revision,disposition,
      requestedWaitMs:value?.requestedWaitMs ?? fact.requestedWaitMs ?? fact.waitMs ?? 0,effectiveWaitMs:value?.effectiveWaitMs ?? fact.waitMs ?? 0,
      elapsedWaitMs:value?.elapsedWaitMs ?? null,returnReason:value?.returnReason ?? null,
      ranges:value ? (["stdout","stderr"] as const).map(stream=>({stream,start:value[stream].byteStart,end:value[stream].byteEnd,omitted:value[stream].omittedBytes})):[],
    },[content(value ? "Returned observation":"Observation request",value ?? {cursor:fact.cursor ?? null,waitMs:fact.waitMs ?? 0},value ? "returned":"received")],observationLinks,observationRecordId);
    if(disposition === "started") {
      interval(observation,"wait","started",null);
      const flow=new ExecutionFlowPath(observationFlow,this.flow,s.ref.runId,[flowRef(observation),flowRef(invocation)],()=>this.occurredAt);
      const step=flow.advance("wait",{waitMs:fact.waitMs ?? 0},[flowRef(process)]);
      step.check("run_identity","passed");step.check("cursor_valid","passed");step.check("wait_bound","passed",{waitMs:fact.waitMs ?? 0});
      this.observationFlows.set(fact.observationId,flow);
    } else {
      interval(observation,"wait","settled",disposition);
      const flow=this.observationFlows.get(fact.observationId);
      flow?.advance("return",{reason:value?.returnReason ?? disposition},[flowRef(observation)]);
      flow?.close(disposition === "cancelled" ? "cancelled":"returned",undefined,[flowRef(observation)]);
      this.observationFlows.delete(fact.observationId);
      if(value) for(const stream of ["stdout","stderr"] as const) {
        const slice=value[stream];
        const range=ref("contribution",`${value.id}:${stream}:range`,"1");
        const text=ref("contribution",`${value.id}:${stream}:text`,"1");
        const rangeRecordId=`${observationRecordId}:${stream}:range`;
        const textRecordId=`${observationRecordId}:${stream}:text`;
        offer(range,{kind:"transfer",stage:"produced",producerId:process.id,consumerId:text.id,operation:"captured_byte_range"},
          [content("Captured range",{stream,byteStart:slice.byteStart,byteEnd:slice.byteEnd,receivedBytes:slice.receivedBytes,omittedBytes:slice.omittedBytes},"captured_range")],
          [link("produces",process,range)],rangeRecordId);
        offer(text,{kind:"transfer",stage:"transformed",producerId:range.id,consumerId:observation.id,operation:"incremental_decoding_and_bounded_selection"},
          [content("Returned stream",slice,"decoded")],[
            {...link("transforms",range,text,"incremental_decoding_and_bounded_selection"),sourceLocation:location(rangeRecordId,"captured_range"),targetLocation:location(textRecordId,"decoded")},
            {...link("includes",text,observation),sourceLocation:location(textRecordId,"decoded"),targetLocation:location(observationRecordId,"returned",`/${stream}`)},
          ],textRecordId);
      }
    }
  };
}
type Link=Omit<InspectionLink,"id"|"establishedBy">;
function flowRef({owner,kind,id,revision,runId}:InspectionSubjectRef) { return {owner,kind,id,revision,runId}; }
function location(recordId:string,stage:string,jsonPointer="") {
  return {contentId:createHash("sha256").update(`${recordId}:content:0`).digest("hex"),partId:null,jsonPointer,stage};
}
function link(kind:InspectionLink["kind"],from:InspectionSubjectRef,to:InspectionSubjectRef,operation:string|null=null):Link {
  return {kind,from,to,operation,condition:null,sourceLocation:null,targetLocation:null};
}
function content(name:string,value:unknown,stage:string):InspectionContentInput {
  return {name,value:value as InspectionJson,stage,class:"execution",mediaType:"application/json"};
}
function processPayload(s:ProcessSnapshot):InspectionPayload {
  return {kind:"process",phase:s.phase,revision:s.revision,backend:s.backend.kind,processId:s.process?.processId ?? null,
    helperProcessId:s.helperProcessId,rootExit:s.rootExit,containment:s.containment.disposition,capture:s.output.capture,
    persistence:s.output.persistence,outcome:s.outcome};
}

import { randomUUID } from "node:crypto";
import { InspectionRecorder, InspectionRecorderError } from "@agent-anything/inspection/recording";
import { RunInspectionAdapter, RunTranscriptInspectionAdapter, ProviderInspectionAdapter, DefinitionInspectionAdapter, RunExecutionInspectionAdapter, RuntimeEventInspectionAdapter, ActionExecutionInspectionAdapter, RunTraceInspectionAdapter, inspectionLink } from "@agent-anything/inspection/adapters";
import { snapshotHelarcInspectionSettings, type HelarcInspectionSettings, type HelarcInspectionSettingsSnapshot } from "../../shared/HelarcInspectionSettings.js";
import { SerializedAtomicFile } from "../persistence/SerializedAtomicFile.js";
import { ExecutionFlowInspectionAdapter } from "@agent-anything/inspection/adapters";
import {ProcessInspectionAdapter} from "./ProcessInspectionAdapter.js";
import { CommandConstraintInspectionAdapter } from "./CommandConstraintInspectionAdapter.js";
import { FinalReplyInspectionAdapter } from "./FinalReplyInspectionAdapter.js";
import { ExecutionEvidenceInspectionAdapter } from "@agent-anything/inspection/adapters";
import { FileMaterialInspectionAdapter } from "./FileMaterialInspectionAdapter.js";
import {ContextMaterialInspectionAdapter} from "./ContextMaterialInspectionAdapter.js";
import {ActivityHandoffInspectionAdapter} from "./ActivityHandoffInspectionAdapter.js";
import {ContextFoundationInspectionAdapter} from "./ContextFoundationInspectionAdapter.js";
import {ExecutionPerformanceInspectionAdapter} from "./ExecutionPerformanceInspectionAdapter.js";
import {ProtocolJournalInspectionAdapter} from "./ProtocolJournalInspectionAdapter.js";
import {throughSequence} from "./InspectionReplay.js";
import type {HelarcExecutionStore} from "../execution-storage/HelarcExecutionStore.js";
import type {RecordingReplayBounds} from "../execution-storage/ExecutionRecording.js";

type RecordingStore=Pick<HelarcExecutionStore,"registerRecording">&Partial<Pick<HelarcExecutionStore,
  "recordingReplayBounds"|"activityHandoffs"|"contextFoundationFacts"|"readRunTreeMembers"|"protocolJournal"|"materialDeliveryFacts"|"contextSelections">>;

const defaults: HelarcInspectionSettings = Object.freeze({ enabled: true, definition: true, agent: true, provider: true, execution: true });

export class HelarcInspection {
  private historyTail:Promise<void>=Promise.resolve();
  readonly runObserver: RunInspectionAdapter | undefined;
  readonly transcriptObserver: import("@agent-anything/agent-runtime/transcript").RunTranscriptObserver | undefined;
  readonly providerObserver: ProviderInspectionAdapter | undefined;
  readonly definitions: DefinitionInspectionAdapter | undefined;
  readonly executionObserver: RunExecutionInspectionAdapter | undefined;
  readonly runtimeEvents: RuntimeEventInspectionAdapter | undefined;
  readonly actionObserver: ActionExecutionInspectionAdapter | undefined;
  readonly evidenceObserver: ExecutionEvidenceInspectionAdapter | undefined;
  readonly fileMaterialObserver: FileMaterialInspectionAdapter | undefined;
  readonly contextMaterialObserver: ContextMaterialInspectionAdapter | undefined;
  readonly activityObserver: ActivityHandoffInspectionAdapter | undefined;
  readonly performanceObserver:ExecutionPerformanceInspectionAdapter|undefined;
  readonly contextFoundationObserver:ContextFoundationInspectionAdapter|undefined;
  readonly protocolObserver:ProtocolJournalInspectionAdapter|undefined;
  readonly traceObserver: RunTraceInspectionAdapter | undefined;
  readonly processObserver: import("@agent-anything/helarc-local-environment/command").ProcessExecutionObserver | undefined;
  readonly commandConstraintObserver: import("@agent-anything/helarc-local-environment/command").CommandConstraintObserver | undefined;
  readonly executionFlow: import("@agent-anything/observability/execution-flow").ExecutionFlowContext | undefined;
  private constructor(private readonly file: SerializedAtomicFile, private settings: HelarcInspectionSettings, readonly recorder: InspectionRecorder | null, private readonly failure: string | null) {
    this.runObserver = recorder ? new RunInspectionAdapter(recorder) : undefined;
    if (recorder) {
      const transcript = new RunTranscriptInspectionAdapter(recorder);
      const reply = new FinalReplyInspectionAdapter(recorder);
      this.transcriptObserver = {observe(record) { transcript.observe(record); reply.observe(record); }};
    }
    this.providerObserver = recorder ? new ProviderInspectionAdapter(recorder) : undefined;
    this.definitions = recorder ? new DefinitionInspectionAdapter(recorder) : undefined;
    this.executionObserver = recorder ? new RunExecutionInspectionAdapter(recorder) : undefined;
    this.runtimeEvents = recorder ? new RuntimeEventInspectionAdapter(recorder) : undefined;
    this.actionObserver = recorder ? new ActionExecutionInspectionAdapter(recorder) : undefined;
    this.evidenceObserver = recorder ? new ExecutionEvidenceInspectionAdapter(recorder) : undefined;
    this.fileMaterialObserver = recorder ? new FileMaterialInspectionAdapter(recorder) : undefined;
    this.contextMaterialObserver = recorder ? new ContextMaterialInspectionAdapter(recorder) : undefined;
    this.activityObserver = recorder ? new ActivityHandoffInspectionAdapter(recorder) : undefined;
    this.performanceObserver=recorder?new ExecutionPerformanceInspectionAdapter(recorder):undefined;
    this.contextFoundationObserver=recorder?new ContextFoundationInspectionAdapter(recorder):undefined;
    this.protocolObserver=recorder?new ProtocolJournalInspectionAdapter(recorder):undefined;
    this.traceObserver = recorder ? new RunTraceInspectionAdapter(recorder) : undefined;
    this.executionFlow = recorder ? {observer: new ExecutionFlowInspectionAdapter(recorder)} : undefined;
    this.processObserver = recorder ? new ProcessInspectionAdapter(recorder,this.executionFlow!).observe : undefined;
    this.commandConstraintObserver = recorder ? new CommandConstraintInspectionAdapter(this.executionFlow!).observe : undefined;
  }
  static async create(settingsPath: string, root?: string): Promise<HelarcInspection> {
    const file = new SerializedAtomicFile(settingsPath);
    let settings = defaults;
    try {
      const text = await file.transact((file) => file.readText());
      if (text !== null) {
        const document = JSON.parse(text);
        if (document?.formatVersion !== 1 || Object.keys(document).length !== 2) throw new Error("inspection_settings_invalid");
        settings = snapshotHelarcInspectionSettings(document.settings);
      }
      const recorder = await InspectionRecorder.create({ root, application: "helarc-desktop", name: "Helarc Desktop", policy: { revision: randomUUID(), ...settings } });
      return new HelarcInspection(file, settings, recorder, null);
    } catch (error) { return new HelarcInspection(file, settings, null, error instanceof InspectionRecorderError ? error.code : "inspection_unavailable"); }
  }
  snapshot(): HelarcInspectionSettingsSnapshot {
    const health = this.recorder?.health();
    return { settings: this.settings, health: { available: health?.available ?? false, queued: health?.queued ?? 0, dropped: health?.dropped ?? 0, rejected: health?.rejected ?? 0, code: health?.code ?? this.failure } };
  }
  recordRecoveredDelivery(input: {runId: string; threadId: string; productRunId: string; checkpointId: string; checkpointRevision: number; completedAt: string}): void {
    const r = this.recorder;
    if (!r) return;
    try {
      const delivery = r.ref("helarc", "contribution", `${input.productRunId}:recovered-delivery`, input.runId);
      r.offer({subject: delivery, occurredAt: new Date().toISOString(),
        payload: {kind: "event", name: "execution.result_delivery.recovered", sequence: null, code: null},
        links: [inspectionLink("produces", r.ref("runtime", "run", input.runId, input.runId), delivery),
          inspectionLink("includes", r.ref("execution-store", "contribution", input.checkpointId, input.runId, String(input.checkpointRevision)), delivery)],
        contents: [{name: "Recovered result delivery", class: "execution", stage: "delivered", mediaType: "application/json", value: input}]});
    } catch { /* Optional observation cannot invalidate an acknowledged delivery. */ }
  }
  recordConversationHandoff(runId: string, handoff: import("../run/HelarcConversationHandoff.js").HelarcConversationHandoff, recovered: boolean): void {
    const r = this.recorder;
    if (!r) return;
    try {
      const seed = handoff.seed;
      const subject = r.ref("helarc", "contribution", `${runId}:conversation-handoff`, runId, seed.digest);
      r.offer({subject, occurredAt: new Date().toISOString(),
        payload: {kind: "event", name: "conversation.handoff.admitted", sequence: null, code: null},
        links: [inspectionLink("produces", r.ref("runtime", "run", seed.sourceRunId, seed.sourceRunId, seed.sourceRevision), subject),
          inspectionLink("includes", subject, r.ref("runtime", "run", runId, runId))],
        contents: [{name: "Conversation handoff", class: "agent", stage: recovered ? "recovered" : "admitted", mediaType: "application/json",
          value: JSON.parse(JSON.stringify({runId, recovered, ...handoff}))}]});
    } catch { /* Observation cannot change accepted conversation or material access. */ }
  }
  async save(candidate: unknown): Promise<HelarcInspectionSettingsSnapshot> {
    const settings = snapshotHelarcInspectionSettings(candidate);
    await this.file.transact(async (file) => {
      await file.replaceText(JSON.stringify({ formatVersion: 1, settings }));
      this.performanceObserver?.flush();
      this.recorder?.setPolicy({ revision: randomUUID(), ...settings });
      this.settings = settings;
    });
    await this.recorder?.flush();
    return this.snapshot();
  }
  recordRecoveryBindingCheck(input: {runId: string; outcome: "accepted" | "rejected"; code: string | null; component: string; changedVariableNames: readonly string[];
    action?:"restore_activity_scope"|"restore_task_composition";bindingId?:string;checkpoint?:{id:string;revision:number};
    limitation?:import("../../shared/HelarcExecutionRecovery.js").RecoveryBindingLimitation}): void {
    const r = this.recorder;
    if (!r) return;
    try {
      const subject = r.ref("helarc", "contribution", `${input.runId}:recovery-binding:${randomUUID()}`, input.runId);
      r.offer({subject, occurredAt: new Date().toISOString(),
        payload: {kind: "event", name: "execution.recovery.binding_checked", sequence: null, code: input.code},
        links: [inspectionLink("includes", r.ref("runtime", "run", input.runId, input.runId), subject),
          ...(input.checkpoint?[inspectionLink("includes",r.ref("execution-store","contribution",input.checkpoint.id,input.runId,String(input.checkpoint.revision)),subject)]:[])],
        contents: [{name: "Recovery binding check", class: "execution", stage: "checked", mediaType: "application/json", value: input}]});
    } catch { /* Observation is not recovery authority. */ }
  }
  async registerExecutionRecording(runId: string, recovery: boolean, store: RecordingStore): Promise<void> {
    const r = this.recorder;
    if (!r || !this.settings.enabled || !r.health().available) return;
    let target: import("../execution-storage/ExecutionRecording.js").ExecutionRecording | null = null;
    let limitation: string | null = null;
    try {
      target = (await store.registerRecording({sourceId: r.source.sourceId, datasetId: r.manifest.datasetId, runId})).previous;
      if (!target) limitation = "previous_recording_not_registered";
    } catch { limitation = "recording_registration_unavailable"; }
    if (!recovery) return;
    let bounds:RecordingReplayBounds|undefined;
    try {
      if(store.protocolJournal)this.protocolObserver?.bindContentReader(store.protocolJournal,store.contextSelections);
      bounds=await store.recordingReplayBounds?.(runId);
    }catch{limitation="history_boundary_unavailable";}
    const subject = r.ref("helarc", "contribution", `${runId}:recording-recovery`, runId);
    r.offer({subject, occurredAt: new Date().toISOString(),
      payload: {kind: "recording_link", stage: "recovery_prepared", target, limitation},
      links: [inspectionLink("includes", r.ref("runtime", "run", runId, runId), subject)]});
    if(!store.activityHandoffs&&!store.contextFoundationFacts&&!store.protocolJournal&&!store.materialDeliveryFacts)return;
    r.historyProgress("started");
    const fence=bounds;
    this.historyTail=this.historyTail.then(async()=>{
      if(!fence)throw new Error("history_boundary_unavailable");
      await this.catchUp(runId,store,fence,r);
    }).then(()=>r.historyProgress("confirmed"),()=>r.historyProgress("incomplete"));
  }
  private async catchUp(root:string,store:RecordingStore,bounds:RecordingReplayBounds,r:InspectionRecorder):Promise<void>{
    let incomplete=false;
    const member=async(runId:string)=>{
      const importRange=async(source:keyof Omit<RecordingReplayBounds,"members">,work:()=>Promise<void>)=>{
        let limitation:string|null=null;
        try{await r.confirmNativeWork(work);}
        catch(error){incomplete=true;limitation=error instanceof InspectionRecorderError?error.code:`${source}_replay_incomplete`;}
        const ref=r.ref("inspection","event",`${root}:history:${source}:${runId}`,runId);
        await r.confirmNativeWork(async()=>{
          if(!await r.offerWhenReady({subject:ref,occurredAt:new Date().toISOString(),
            payload:{kind:"event",name:"inspection.history_range",sequence:bounds[source],code:limitation},
            contents:[{name:"Historical coverage",class:"execution",stage:"history_range",mediaType:"application/json",
              value:{root,runId,source,through:bounds[source],status:limitation?"incomplete":"confirmed",limitation}}]}))throw new Error("history_range_not_recorded");
        });
      };
      if(store.activityHandoffs)await importRange("activity",()=>this.activityObserver!.replay(runId,store.activityHandoffs!,bounds.activity));
      if(store.contextFoundationFacts)await importRange("context",()=>this.contextFoundationObserver!.replay(runId,(_run,after,limit)=>
        throughSequence((a,n)=>store.contextFoundationFacts!(runId,a,n),bounds.context)(after,limit)));
      if(store.protocolJournal)await importRange("protocol",()=>this.protocolObserver!.replay(throughSequence(async(after,limit)=>
        await store.protocolJournal!.command({kind:"facts",runId,after,limit}) as readonly import("@agent-anything/agent-runtime/model-access").ProtocolJournalFact[],bounds.protocol)));
      if(store.materialDeliveryFacts)await importRange("material",()=>this.protocolObserver!.replay(throughSequence((a,n)=>store.materialDeliveryFacts!(runId,a,n),bounds.material)));
    };
    await member(root);
    if(store.readRunTreeMembers&&bounds.members){
      let cursor:import("../execution-storage/RunTreeMembership.js").RunTreeMembershipCursor|null={rootRunId:root,after:0,through:bounds.members};
      do{const page:import("../execution-storage/RunTreeMembership.js").RunTreeMembershipPage=await store.readRunTreeMembers(root,cursor);
        for(const id of page.runIds)if(id!==root)await member(id);
        cursor=page.next;
      }while(cursor);
    }
    if(incomplete)throw new Error("history_replay_incomplete");
  }
  async drainSources():Promise<void>{
    await this.historyTail;
    await this.protocolObserver?.flush();
  }
  async flushRecording(close=false) {
    await this.drainSources();
    this.performanceObserver?.flush();
    return this.recorder?.flush(close);
  }
  async close(): Promise<void> {
    this.performanceObserver?.close();
    const result = await this.flushRecording(true);
    if (result && (result.native !== "settled" || result.projection !== "settled"))
      console.warn("Helarc inspection closure is incomplete.", result);
  }
}

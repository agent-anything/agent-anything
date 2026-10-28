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

const defaults: HelarcInspectionSettings = Object.freeze({ enabled: true, definition: true, agent: true, provider: true, execution: true });

export class HelarcInspection {
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
  readonly contextFoundationObserver:ContextFoundationInspectionAdapter|undefined;
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
    this.contextFoundationObserver=recorder?new ContextFoundationInspectionAdapter(recorder):undefined;
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
  async save(candidate: unknown): Promise<HelarcInspectionSettingsSnapshot> {
    const settings = snapshotHelarcInspectionSettings(candidate);
    await this.file.transact(async (file) => {
      await file.replaceText(JSON.stringify({ formatVersion: 1, settings }));
      this.recorder?.setPolicy({ revision: randomUUID(), ...settings });
      this.settings = settings;
    });
    await this.recorder?.flush();
    return this.snapshot();
  }
  recordRecoveryBindingCheck(input: {runId: string; outcome: "accepted" | "rejected"; code: string | null; component: string; changedVariableNames: readonly string[]}): void {
    const r = this.recorder;
    if (!r) return;
    try {
      const subject = r.ref("helarc", "contribution", `${input.runId}:recovery-binding:${randomUUID()}`, input.runId);
      r.offer({subject, occurredAt: new Date().toISOString(),
        payload: {kind: "event", name: "execution.recovery.binding_checked", sequence: null, code: input.code},
        links: [inspectionLink("includes", r.ref("runtime", "run", input.runId, input.runId), subject)],
        contents: [{name: "Recovery binding check", class: "execution", stage: "checked", mediaType: "application/json", value: input}]});
    } catch { /* Observation is not recovery authority. */ }
  }
  async registerExecutionRecording(runId: string, recovery: boolean, store: Pick<import("../execution-storage/HelarcExecutionStore.js").HelarcExecutionStore, "registerRecording"> & Partial<Pick<import("../execution-storage/HelarcExecutionStore.js").HelarcExecutionStore,"activityHandoffs"|"contextFoundationFacts"|"readRunTree">>): Promise<void> {
    const r = this.recorder;
    if (!r || !this.settings.enabled || !r.health().available) return;
    let target: import("../execution-storage/ExecutionRecording.js").ExecutionRecording | null = null;
    let limitation: string | null = null;
    try {
      target = (await store.registerRecording({sourceId: r.source.sourceId, datasetId: r.manifest.datasetId, runId})).previous;
      if (!target) limitation = "previous_recording_not_registered";
    } catch { limitation = "recording_registration_unavailable"; }
    if (!recovery) return;
    const runIds=new Set([runId]);
    if(store.readRunTree) {
      try{for(const member of (await store.readRunTree(runId))?.members??[])runIds.add(member.head.state.run.id);}
      catch{limitation="activity_tree_replay_incomplete";}
    }
    for(const memberRunId of runIds) {
    if (store.activityHandoffs) {
      try {await this.activityObserver?.replay(memberRunId,store.activityHandoffs);}
      catch {limitation = "activity_fact_replay_incomplete";}
    }
    if(store.contextFoundationFacts) {
      try{await this.contextFoundationObserver?.replay(memberRunId,store.contextFoundationFacts.bind(store));}
      catch{limitation="context_fact_replay_incomplete";}
    }
    }
    const subject = r.ref("helarc", "contribution", `${runId}:recording-recovery`, runId);
    r.offer({subject, occurredAt: new Date().toISOString(),
      payload: {kind: "recording_link", stage: "recovery_prepared", target, limitation},
      links: [inspectionLink("includes", r.ref("runtime", "run", runId, runId), subject)]});
  }
  async close(): Promise<void> {
    const result = await this.recorder?.flush(true);
    if (result && (result.native !== "settled" || result.projection !== "settled"))
      console.warn("Helarc inspection closure is incomplete.", result);
  }
}

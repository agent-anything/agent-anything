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
  async close(): Promise<void> {
    const result = await this.recorder?.flush(true);
    if (result && (result.native !== "settled" || result.projection !== "settled"))
      console.warn("Helarc inspection closure is incomplete.", result);
  }
}

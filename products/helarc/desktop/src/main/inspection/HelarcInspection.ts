import { randomUUID } from "node:crypto";
import { InspectionRecorder, InspectionRecorderError } from "@agent-anything/inspection/recording";
import { RunInspectionAdapter, RunTranscriptInspectionAdapter, ProviderInspectionAdapter, DefinitionInspectionAdapter, RunExecutionInspectionAdapter, RuntimeEventInspectionAdapter, ActionExecutionInspectionAdapter, RunTraceInspectionAdapter } from "@agent-anything/inspection/adapters";
import { snapshotHelarcInspectionSettings, type HelarcInspectionSettings, type HelarcInspectionSettingsSnapshot } from "../../shared/HelarcInspectionSettings.js";
import { SerializedAtomicFile } from "../persistence/SerializedAtomicFile.js";
import { ExecutionFlowInspectionAdapter } from "@agent-anything/inspection/adapters";
import {ProcessInspectionAdapter} from "./ProcessInspectionAdapter.js";

const defaults: HelarcInspectionSettings = Object.freeze({ enabled: true, definition: true, agent: true, provider: true, execution: true });

export class HelarcInspection {
  readonly runObserver: RunInspectionAdapter | undefined;
  readonly transcriptObserver: RunTranscriptInspectionAdapter | undefined;
  readonly providerObserver: ProviderInspectionAdapter | undefined;
  readonly definitions: DefinitionInspectionAdapter | undefined;
  readonly executionObserver: RunExecutionInspectionAdapter | undefined;
  readonly runtimeEvents: RuntimeEventInspectionAdapter | undefined;
  readonly actionObserver: ActionExecutionInspectionAdapter | undefined;
  readonly traceObserver: RunTraceInspectionAdapter | undefined;
  readonly processObserver: import("@agent-anything/helarc-local-environment/command").ProcessExecutionObserver | undefined;
  readonly executionFlow: import("@agent-anything/observability/execution-flow").ExecutionFlowContext | undefined;
  private constructor(private readonly file: SerializedAtomicFile, private settings: HelarcInspectionSettings, readonly recorder: InspectionRecorder | null, private readonly failure: string | null) {
    this.runObserver = recorder ? new RunInspectionAdapter(recorder) : undefined;
    this.transcriptObserver = recorder ? new RunTranscriptInspectionAdapter(recorder) : undefined;
    this.providerObserver = recorder ? new ProviderInspectionAdapter(recorder) : undefined;
    this.definitions = recorder ? new DefinitionInspectionAdapter(recorder) : undefined;
    this.executionObserver = recorder ? new RunExecutionInspectionAdapter(recorder) : undefined;
    this.runtimeEvents = recorder ? new RuntimeEventInspectionAdapter(recorder) : undefined;
    this.actionObserver = recorder ? new ActionExecutionInspectionAdapter(recorder) : undefined;
    this.traceObserver = recorder ? new RunTraceInspectionAdapter(recorder) : undefined;
    this.executionFlow = recorder ? {observer: new ExecutionFlowInspectionAdapter(recorder)} : undefined;
    this.processObserver = recorder ? new ProcessInspectionAdapter(recorder,this.executionFlow!).observe : undefined;
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
  async close(): Promise<void> { await this.recorder?.flush(true); }
}

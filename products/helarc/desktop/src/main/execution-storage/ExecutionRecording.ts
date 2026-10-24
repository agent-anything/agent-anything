/** Diagnostic identity only; never used to authorize or replay execution. */
export interface ExecutionRecording {
  readonly sourceId: string;
  readonly datasetId: string;
  readonly runId: string;
}
export interface ExecutionRecordingRegistration {
  readonly current: ExecutionRecording;
  readonly previous: ExecutionRecording | null;
}

export function assertExecutionRecording(value: ExecutionRecording): void {
  if (!value || Object.keys(value).length !== 3 ||
      [value.sourceId, value.datasetId, value.runId].some(item => typeof item !== "string" || !item.length || item.length > 512)) {
    throw new Error("execution_recording_invalid");
  }
}

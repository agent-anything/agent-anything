import type { ProcessSnapshot, ProcessObservation, ProcessInputNotification } from "./ProcessObservation.js";
import type { ProcessOutputCheckpoint, ProcessOutputPaths } from "./ProcessOutputStore.js";
import { OperationCommitError } from "@agent-anything/operation-catalog/result";

export interface ProcessCheckpoint {
  readonly version: 1;
  readonly revision: number;
  readonly input: {
    readonly runId: string;
    readonly executionId: string;
    readonly actionId: string;
    readonly origin: ProcessSnapshot["origin"];
    readonly environmentId: string;
    readonly executable: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
    readonly deadlineAt: string;
    readonly paths: ProcessOutputPaths;
    readonly maximumOutputBytes: number;
    readonly background: boolean;
    readonly displayCommand: {readonly shell: string; readonly command: string} | null;
  };
  readonly launchIntent: boolean;
  readonly snapshot: ProcessSnapshot;
  readonly output: ProcessOutputCheckpoint | null;
  readonly observationSequence: number;
  readonly initialSnapshot: ProcessObservation | null;
  readonly observations: readonly ProcessObservation[];
  readonly initialDelivery: string | null;
  readonly deliveryCursor: string | null;
  readonly deliveryState: string | null;
  readonly notifications: readonly ProcessInputNotification[];
}

export interface ProcessRecordPort {
  commitProcess(checkpoint: ProcessCheckpoint): Promise<void>;
  readProcesses(runId: string): Promise<readonly ProcessCheckpoint[]>;
}

export class ProcessRecordError extends OperationCommitError {
  constructor(readonly executionId: string, options?: ErrorOptions) {
    super("helarc-command", executionId, options);
    this.name = "ProcessRecordError";
  }
}

export function validateProcessCheckpoint(next: ProcessCheckpoint, previous: ProcessCheckpoint | null): void {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (next.version !== 1 || !Number.isSafeInteger(next.revision) || next.revision < 0 ||
      next.snapshot.ref.runId !== next.input.runId || next.snapshot.ref.executionId !== next.input.executionId ||
      next.snapshot.actionId !== next.input.actionId || !same(next.snapshot.origin, next.input.origin) ||
      !Number.isFinite(Date.parse(next.input.deadlineAt)) ||
      !Number.isSafeInteger(next.observationSequence) || next.observationSequence < 0 ||
      next.output !== null && next.output.executionId !== next.input.executionId) throw new ProcessRecordError(next.input.executionId);
  let sequence = 0;
  for (const item of next.notifications) {
    if (item.runId !== next.input.runId || item.source.id !== next.input.executionId ||
        !Number.isSafeInteger(item.sequence) || item.sequence <= sequence) throw new ProcessRecordError(next.input.executionId);
    sequence = item.sequence;
  }
  if (next.observations.some(item => !same(item.execution, next.snapshot.ref)) ||
      new Set(next.observations.map(item => item.invocationId)).size !== next.observations.length) throw new ProcessRecordError(next.input.executionId);
  if (!previous) {
    if (next.revision !== 0 || next.launchIntent || next.snapshot.process !== null) throw new ProcessRecordError(next.input.executionId);
    return;
  }
  if (!same(next.input, previous.input) || next.revision !== previous.revision + 1 ||
      previous.launchIntent && !next.launchIntent || next.snapshot.revision < previous.snapshot.revision ||
      next.observationSequence < previous.observationSequence ||
      previous.initialDelivery !== null && previous.initialDelivery !== next.initialDelivery ||
      !same(previous.notifications, next.notifications.slice(0, previous.notifications.length)) ||
      !same(previous.observations, next.observations.slice(0, previous.observations.length))) throw new ProcessRecordError(next.input.executionId);
}

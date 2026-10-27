import type { ProcessSnapshot, ProcessObservation, ProcessInputNotification } from "./ProcessObservation.js";
import type { ProcessOutputCheckpoint, ProcessOutputPaths } from "./ProcessOutputStore.js";
import { OperationCommitError } from "@agent-anything/operation-catalog/result";
import {decodeProcessOutputCursor} from "./ProcessOutputCursor.js";
import type {CommandObservation} from "./CommandObservation.js";
import {processOutputViewSegments, type ProcessOutputMaterialView} from "./ProcessOutputMaterials.js";

export interface ProcessCheckpoint<Environment = Readonly<Record<string, string>>> {
  readonly version: 4;
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
    readonly environment: Environment;
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
  readonly commandObservations: readonly CommandObservation[];
  readonly materialViews: readonly ProcessOutputMaterialView[];
  readonly initialDelivery: string | null;
  readonly deliveryCursor: string | null;
  readonly announcedOutputCursor: string | null;
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

export function validateProcessCheckpoint<Environment>(next: ProcessCheckpoint<Environment>, previous: ProcessCheckpoint<Environment> | null): void {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (next.version !== 4 || !Number.isSafeInteger(next.revision) || next.revision < 0 ||
      next.snapshot.ref.runId !== next.input.runId || next.snapshot.ref.executionId !== next.input.executionId ||
      next.snapshot.actionId !== next.input.actionId || !same(next.snapshot.origin, next.input.origin) ||
      !Number.isFinite(Date.parse(next.input.deadlineAt)) ||
      !Number.isSafeInteger(next.observationSequence) || next.observationSequence < 0 ||
      next.output !== null && next.output.executionId !== next.input.executionId) throw new ProcessRecordError(next.input.executionId);
  try {
    const available = {stdout: next.output?.streams.stdout.segments.length ?? 0, stderr: next.output?.streams.stderr.segments.length ?? 0};
    const cursor = (value: string) => decodeProcessOutputCursor(value, next.input.executionId, available);
    for (const value of [next.deliveryCursor, next.announcedOutputCursor]) if (value !== null) cursor(value);
    if (next.initialDelivery === null && (next.deliveryCursor !== null || next.announcedOutputCursor !== null || next.deliveryState !== null)) throw new Error();
    for (const observation of next.observations) {
      const frontier = cursor(observation.availableOutputCursor);
      decodeProcessOutputCursor(observation.nextCursor, next.input.executionId, frontier);
    }
    if (next.initialSnapshot !== null && !next.observations.some(item => same(item, next.initialSnapshot))) throw new Error();
    if (previous?.initialSnapshot !== null && previous?.initialSnapshot !== undefined && !same(previous.initialSnapshot, next.initialSnapshot)) throw new Error();
    if (previous?.announcedOutputCursor != null) {
      if (next.announcedOutputCursor === null) throw new Error();
      decodeProcessOutputCursor(previous.announcedOutputCursor, next.input.executionId, cursor(next.announcedOutputCursor));
    }
    if (next.announcedOutputCursor !== null && next.deliveryCursor !== null) {
      decodeProcessOutputCursor(next.deliveryCursor, next.input.executionId, cursor(next.announcedOutputCursor));
    }
  } catch (cause) { throw new ProcessRecordError(next.input.executionId, {cause}); }
  let sequence = 0;
  try {
    if (!Array.isArray(next.materialViews) || !Array.isArray(next.commandObservations)) throw new Error();
    for (const view of next.materialViews) {
      if (!next.output) throw new Error();
      processOutputViewSegments(next.output, view, next.input.runId);
    }
    if (new Set(next.materialViews.map(view=>view.reference.id)).size !== next.materialViews.length ||
        new Set(next.commandObservations.map(value=>value.invocationId)).size !== next.commandObservations.length) throw new Error();
    for (const [index,observed] of next.commandObservations.entries()) {
      if (observed.snapshot.ref.runId !== next.input.runId || observed.snapshot.ref.executionId !== next.input.executionId ||
          !["snapshot","change","outcome","settled"].includes(observed.request.until) ||
          !Number.isSafeInteger(observed.request.waitMs) || observed.request.waitMs < 0 || observed.request.waitMs > 30_000 ||
          observed.request.until === "change" && !next.commandObservations.slice(0,index).some(before=>before.id === observed.request.after) ||
          observed.request.until !== "change" && observed.request.after !== undefined ||
          observed.materials.some((view:ProcessOutputMaterialView)=>!next.materialViews.some(value=>same(value,view)))) throw new Error();
    }
  } catch (cause) {throw new ProcessRecordError(next.input.executionId, {cause});}
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
      !same(previous.observations, next.observations.slice(0, previous.observations.length)) ||
      !same(previous.commandObservations, next.commandObservations.slice(0, previous.commandObservations.length)) ||
      !same(previous.materialViews, next.materialViews.slice(0, previous.materialViews.length))) throw new ProcessRecordError(next.input.executionId);
}

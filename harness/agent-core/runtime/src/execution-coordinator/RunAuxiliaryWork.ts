import type {AgentActivityExecutionContext} from "../decision/TaskDecisionActivity.js";
import type {RunPreparationRecord, RunPreparationRegistration, RunPreparationWorkPort} from "../context-representation/RunPreparationWork.js";
import {createRunCancellationController, type RunCancellationController, type CancellationContext} from "../run/RunCancellation.js";
import {retainControllerCheckpoint} from "./RunCommitSnapshot.js";
import {AUXILIARY_USAGE_KEY, snapshotControllerAuxiliaryUsage} from "../model-access/AuxiliaryModelUsage.js";
import {TaskDecisionActivityError} from "../decision/TaskDecisionActivityError.js";
import {ActivityCheckpointError} from "../activity/ActivityCheckpoint.js";
import {RetryCheckpointError} from "../retry/RetryCheckpoint.js";
import {ExecutionFlowPath, createExecutionFlowDefinition, type ExecutionFlowContext} from "@agent-anything/observability/execution-flow";

const PREFIX = "controller-auxiliary-work.v1:";
const FLOW = createExecutionFlowDefinition({owner: "agent-runtime", id: "run-auxiliary-work", revision: "1", label: "Run Auxiliary Work",
  description: "Run-owned technical producer; generation is not adoption or a working Agent Turn.",
  steps: [{id: "registered", label: "Retain producer identity", kind: "entry", checks: []},
    {id: "running", label: "Execute bounded auxiliary work", kind: "call", checks: []},
    {id: "settled", label: "Retain producer outcome", kind: "exit", checks: []}],
  transitions: [{id: "start", from: "registered", to: "running", label: "Start or recover"},
    {id: "finish", from: "running", to: "settled", label: "Producer settled"}], entryStepIds: ["registered"], exitStepIds: ["settled"]});
/** Run-owned producer registry. Saved checkpoints, not Promise handles, survive restart. */
export class RunAuxiliaryWork {
  private active: {id: string; cancellation: RunCancellationController; settled: Promise<void>} | null = null;
  private closed = false;
  private acceptingWrites = true;
  private failure: unknown = null;
  private unconfirmed = false;
  constructor(private readonly owner: {
    readonly runId: string;
    readonly cancellation: CancellationContext;
    readonly deadlineAt: string;
    readonly executionFlow?: ExecutionFlowContext;
    now(): string;
    authority(): string;
    read(key: string): unknown;
    commit(id: string, writes: readonly {key: string; value: unknown}[], guard?: () => void): Promise<void>;
    context(id: string, cancellation: CancellationContext, deadlineAt: string): Omit<AgentActivityExecutionContext, "checkpoints" | "runCheckpoints" | "auxiliaryWork">;
    assertAdmission(): void;
  }) {}

  port(assertCurrent: () => Promise<() => void>): RunPreparationWorkPort {
    return {current: () => {const id = this.owner.read(`${PREFIX}current`); return typeof id === "string" ? this.read(id) : null;},
      read: id => this.read(id), wait: async id => {if (this.active?.id === id) await this.active.settled; if (this.failure) throw this.failure;},
      start: async (registration, execute) => {
        const guard = await assertCurrent(); this.owner.assertAdmission();
        if (this.closed || this.active && this.active.id !== registration.id) return false;
        if (this.active) return true;
        if (!registration.id || !registration.binding || !Number.isFinite(Date.parse(registration.deadlineAt)) ||
            Date.parse(registration.deadlineAt) > Date.parse(this.owner.deadlineAt)) throw new TypeError("Invalid auxiliary registration.");
        const previous = this.read(registration.id);
        if (previous && (previous.binding !== registration.binding || previous.deadlineAt !== registration.deadlineAt)) throw new TypeError("Auxiliary binding changed.");
        if (previous?.status !== undefined && previous.status !== "registered") return true;
        const record: RunPreparationRecord = previous ?? {...registration, authority: this.owner.authority(), status: "registered", failure: null};
        if (record.authority !== this.owner.authority() || Date.parse(record.deadlineAt) <= Date.parse(this.owner.now())) {
          await this.save({...record, status: "cancelled", failure: "auxiliary_basis_expired"}); return true;
        }
        await this.write(record.id, [{key: this.key(record.id), value: record}, {key: `${PREFIX}current`, value: record.id}], guard);
        const flow = new ExecutionFlowPath(FLOW, this.owner.executionFlow ?? {}, this.owner.runId,
          [{owner: "context", kind: "preparation", id: record.id, revision: null}]);
        flow.advance("registered", {preparationId: record.id, binding: record.binding, deadlineAt: record.deadlineAt, recovered: previous !== null});
        flow.advance("running");
        // Registration is durable before any Provider request can start.
        const cancellation = createRunCancellationController({runId: this.owner.runId,
          createRequestId: () => `${record.id}:cancellation`, now: () => this.owner.now()});
        const abort = () => cancellation.requestCancellation({origin: "runner", reasonCode: "runner_shutdown", reason: "Auxiliary work retired."});
        this.owner.cancellation.signal.addEventListener("abort", abort, {once: true});
        if (this.owner.cancellation.signal.aborted) abort();
        const timer = setTimeout(abort, Math.min(2_147_483_647, Math.max(0, Date.parse(record.deadlineAt) - Date.parse(this.owner.now()))));
        const namespace = (key: string) => `${PREFIX}checkpoint:${JSON.stringify([record.id, key])}`;
        const base = this.owner.context(record.id, cancellation.context, record.deadlineAt);
        const assertWritable = () => {if (!this.acceptingWrites) throw new Error("Auxiliary writes are closed.");};
        const context: AgentActivityExecutionContext = {...base,
          auxiliaryInvocationId: record.id,
          retry: {...base.retry, events: {emit: event => {assertWritable(); return base.retry.events.emit(event);}}},
          ...(base.auxiliaryUsage ? {auxiliaryUsage: {
            assertAvailable: () => {assertWritable(); cancellation.context.signal.throwIfAborted(); base.auxiliaryUsage!.assertAvailable();},
            record: value => {assertWritable(); return base.auxiliaryUsage!.record(value);}}} : {}),
          checkpoints: {read: key => retainControllerCheckpoint(this.owner.read(namespace(key)) ?? null),
            commit: (key, value) => this.write(record.id, [{key: namespace(key), value: retainControllerCheckpoint(value)}]),
            commitWithAuxiliaryUsage: (key, value, usage) => {
              const retained = snapshotControllerAuxiliaryUsage(usage);
              return this.write(record.id, [{key: namespace(key), value: retainControllerCheckpoint(value)},
                {key: `${AUXILIARY_USAGE_KEY}${retained.attemptId}`, value: retained}]);
            }}};
        const active = {id: record.id, cancellation, settled: Promise.resolve()};
        this.active = active;
        active.settled = Promise.resolve().then(async () => {
          let status: RunPreparationRecord["status"] = "completed", failure: string | null = null;
          try {cancellation.context.signal.throwIfAborted(); await execute(context); cancellation.context.signal.throwIfAborted();}
          catch (error) {
            if (error instanceof ActivityCheckpointError || error instanceof RetryCheckpointError) this.failure = error;
            if (error instanceof TaskDecisionActivityError && error.operationSettlement === "unsettled") this.unconfirmed = true;
            status = cancellation.context.signal.aborted ? "cancelled" : "failed"; failure = error instanceof Error ? error.message : "auxiliary_work_failed";
          }
          await this.save({...record, status, failure});
          flow.advance("settled", {preparationId: record.id, status, failure, adoption: "not_performed"});
          flow.close(status === "completed" ? "returned" : status === "cancelled" ? "cancelled" : "failed");
        }).catch(error => {this.failure = error; flow.close("failed");}).finally(() => {
          clearTimeout(timer); this.owner.cancellation.signal.removeEventListener("abort", abort); cancellation.close();
          if (this.active === active) this.active = null;
        });
        return true;
      }};
  }

  notifyAuthorityChanged(): void {
    if (this.active && this.read(this.active.id)?.authority !== this.owner.authority()) this.active.cancellation.requestCancellation({
      origin: "runner", reasonCode: "runner_shutdown", reason: "Auxiliary authority changed."});
  }

  async close(timeoutMs: number): Promise<boolean> {
    this.closed = true;
    const active = this.active;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (active) {
        active.cancellation.requestCancellation({origin: "runner", reasonCode: "runner_shutdown", reason: "Run auxiliary work is closing."});
        const settled = await Promise.race([active.settled.then(() => true), new Promise<false>(resolve => {timer = setTimeout(() => resolve(false), timeoutMs);})]);
        if (!settled) {await this.save({...this.read(active.id)!, status: "failed", failure: "auxiliary_cancellation_unconfirmed"}); return false;}
      } else {
        const id = this.owner.read(`${PREFIX}current`), retained = typeof id === "string" ? this.read(id) : null;
        if (retained?.status === "registered") await this.save({...retained, status: "cancelled", failure: "auxiliary_retired_on_recovery"});
      }
      if (this.failure) throw this.failure;
      return !this.unconfirmed;
    } finally {if (timer) clearTimeout(timer); this.acceptingWrites = false;}
  }

  private key(id: string): string {return `${PREFIX}registration:${id}`;}
  private read(id: string): RunPreparationRecord | null {
    return retainControllerCheckpoint(this.owner.read(this.key(id)) ?? null) as RunPreparationRecord | null;
  }
  private save(record: RunPreparationRecord): Promise<void> {return this.write(record.id, [{key: this.key(record.id), value: record}]);}
  private write(id: string, writes: readonly {key: string; value: unknown}[], guard?: () => void): Promise<void> {
    if (!this.acceptingWrites) return Promise.reject(new Error("Auxiliary writes are closed."));
    return this.owner.commit(id, writes, () => {if (!this.acceptingWrites) throw new Error("Auxiliary writes are closed."); guard?.();});
  }
}

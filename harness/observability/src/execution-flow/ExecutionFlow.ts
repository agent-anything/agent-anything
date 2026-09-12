import { createHash, randomUUID } from "node:crypto";

export type ExecutionFlowStepKind = "entry" | "process" | "check" | "branch" | "call" | "wait" | "exit";
export interface ExecutionFlowDefinitionRef {
  readonly owner: string;
  readonly id: string;
  readonly revision: string;
  readonly contentDigest: string;
}
export interface ExecutionFlowDefinition extends ExecutionFlowDefinitionRef {
  readonly label: string;
  readonly description: string;
  readonly steps: readonly { readonly id: string; readonly label: string; readonly kind: ExecutionFlowStepKind; readonly checks: readonly string[] }[];
  readonly transitions: readonly { readonly id: string; readonly from: string; readonly to: string; readonly label: string }[];
  readonly entryStepIds: readonly string[];
  readonly exitStepIds: readonly string[];
}
export interface ExecutionFlowSubjectRef {
  readonly owner: string;
  readonly kind: string;
  readonly id: string;
  readonly revision: string | null;
  readonly contentId?: string;
  readonly runId?: string | null;
}
export interface ExecutionFlowOccurrenceRef {
  readonly owner: string;
  readonly runId: string;
  readonly invocationId: string;
  readonly stepExecutionId: string | null;
}
export type ExecutionFlowDisposition = "returned" | "yielded" | "failed" | "cancelled" | "interrupted";
export type ExecutionFlowLinkKind = "next" | "call" | "return" | "spawn" | "join" | "resume";
export type ExecutionFlowBasis = Readonly<Record<string, string | number | boolean | null>>;

interface FlowFact {
  readonly definition: ExecutionFlowDefinitionRef;
  readonly runId: string;
  readonly invocationId: string;
  readonly sequence: number;
  readonly occurredAt: string;
}
export type ExecutionFlowObservation =
  | { readonly kind: "definition"; readonly definition: ExecutionFlowDefinition }
  | FlowFact & (
    | { readonly kind: "invocation_entered"; readonly caller: ExecutionFlowOccurrenceRef | null; readonly subjects: readonly ExecutionFlowSubjectRef[] }
    | { readonly kind: "invocation_exited"; readonly exit: ExecutionFlowOccurrenceRef | null; readonly disposition: ExecutionFlowDisposition; readonly subjects: readonly ExecutionFlowSubjectRef[] }
    | { readonly kind: "step_entered"; readonly stepId: string; readonly stepExecutionId: string; readonly inputs: readonly ExecutionFlowSubjectRef[]; readonly basis: ExecutionFlowBasis }
    | { readonly kind: "step_exited"; readonly stepId: string; readonly stepExecutionId: string; readonly disposition: ExecutionFlowDisposition; readonly branch: string | null; readonly outputs: readonly ExecutionFlowSubjectRef[]; readonly basis: ExecutionFlowBasis }
    | { readonly kind: "constraint"; readonly stepId: string; readonly stepExecutionId: string; readonly checkId: string; readonly disposition: "passed" | "not_satisfied" | "not_applicable" | "not_evaluated" | "error"; readonly configuration: ExecutionFlowSubjectRef | null; readonly basis: ExecutionFlowBasis }
    | { readonly kind: "link"; readonly from: ExecutionFlowOccurrenceRef; readonly to: ExecutionFlowOccurrenceRef; readonly relation: ExecutionFlowLinkKind; readonly transitionId: string | null; readonly establishedBy: ExecutionFlowSubjectRef | null }
  );
export interface ExecutionFlowObserver { observe(observation: ExecutionFlowObservation): void }
export interface ExecutionFlowContext {
  readonly observer?: ExecutionFlowObserver;
  readonly caller?: ExecutionFlowOccurrenceRef;
  readonly relationship?: "call" | "spawn";
}

export function createExecutionFlowDefinition<const T extends Omit<ExecutionFlowDefinition, "contentDigest">>(input: T): T & ExecutionFlowDefinition {
  const {contentDigest: _digest, ...source} = input as T & {contentDigest?: string};
  const definition = JSON.parse(JSON.stringify(source)) as T;
  validateDefinitionShape(definition);
  const result = { ...definition, contentDigest: digest(definition) };
  return freeze(result);
}

export function validateExecutionFlowDefinition(value: ExecutionFlowDefinition): void {
  const {contentDigest, ...definition} = value;
  validateDefinitionShape(definition);
  if (contentDigest !== digest(definition)) throw new TypeError("Execution flow definition digest mismatch.");
}

function validateDefinitionShape(value: Omit<ExecutionFlowDefinition, "contentDigest">): void {
  for (const text of [value.owner, value.id, value.revision, value.label]) if (typeof text !== "string" || !text.trim()) throw new TypeError("Execution flow definition identity is invalid.");
  if (!Array.isArray(value.steps) || value.steps.length === 0 || value.steps.length > 128 || !Array.isArray(value.transitions) || value.transitions.length > 512) throw new TypeError("Execution flow definition exceeds structural limits.");
  const ids = new Set(value.steps.map(step => step.id));
  if (ids.size !== value.steps.length || value.steps.some(step => !step.id || !["entry", "process", "check", "branch", "call", "wait", "exit"].includes(step.kind) || !Array.isArray(step.checks))) throw new TypeError("Execution flow step is invalid.");
  if (new Set(value.transitions.map(edge => edge.id)).size !== value.transitions.length || value.transitions.some(edge => !edge.id || !ids.has(edge.from) || !ids.has(edge.to))) throw new TypeError("Execution flow transition is invalid.");
  if (!Array.isArray(value.entryStepIds) || !Array.isArray(value.exitStepIds) || !value.entryStepIds.length || !value.exitStepIds.length || value.entryStepIds.some(id => !ids.has(id)) || value.exitStepIds.some(id => !ids.has(id))) throw new TypeError("Execution flow entry or exit is invalid.");
  if (typeof value.description !== "string" || value.steps.some(step => typeof step.label !== "string" || !step.label.trim() || step.checks.length > 64 || new Set(step.checks).size !== step.checks.length || step.checks.some((check: unknown) => typeof check !== "string" || !check.trim())) || value.transitions.some(edge => typeof edge.label !== "string")) throw new TypeError("Execution flow description is invalid.");
  if (Buffer.byteLength(JSON.stringify(value)) > 60 * 1024) throw new TypeError("Execution flow definition exceeds its byte limit.");
}

function digest(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v !== null && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : v;
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

/** Diagnostic scope only: owners still perform every decision and transition. */
export class ExecutionFlowInvocation<TStep extends string = string> {
  readonly ref: ExecutionFlowOccurrenceRef;
  private sequence = 0;
  private closed = false;
  private readonly definitionRef: ExecutionFlowDefinitionRef;
  constructor(
    readonly definition: ExecutionFlowDefinition & {readonly steps: readonly {readonly id: TStep}[]},
    readonly context: ExecutionFlowContext,
    readonly runId: string,
    subjects: readonly ExecutionFlowSubjectRef[] = [],
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.definitionRef = {owner: definition.owner, id: definition.id, revision: definition.revision, contentDigest: definition.contentDigest};
    this.ref = Object.freeze({owner: definition.owner, runId, invocationId: randomUUID(), stepExecutionId: null});
    this.publish({kind: "definition", definition});
    this.emit({kind: "invocation_entered", caller: context.caller ?? null, subjects});
    if (context.caller) this.link(context.caller, this.ref, context.relationship ?? "call");
  }

  enter(stepId: TStep, input: {inputs?: readonly ExecutionFlowSubjectRef[]; basis?: ExecutionFlowBasis} = {}): ExecutionFlowStep {
    const ref = Object.freeze({...this.ref, stepExecutionId: randomUUID()});
    this.emit({kind: "step_entered", stepId, stepExecutionId: ref.stepExecutionId, inputs: input.inputs ?? [], basis: input.basis ?? {}});
    let closed = false;
    return Object.freeze({
      ref,
      context: Object.freeze({observer: this.context.observer, caller: ref, relationship: "call" as const}),
      check: (checkId: string, disposition: Extract<ExecutionFlowObservation, {kind: "constraint"}>["disposition"], basis: ExecutionFlowBasis = {}, configuration: ExecutionFlowSubjectRef | null = null) => {
        this.emit({kind: "constraint", stepId, stepExecutionId: ref.stepExecutionId, checkId, disposition, configuration, basis});
      },
      end: (disposition: ExecutionFlowDisposition = "returned", basis: ExecutionFlowBasis = {}, branch: string | null = null, outputs: readonly ExecutionFlowSubjectRef[] = []) => {
        if (closed) return; closed = true;
        this.emit({kind: "step_exited", stepId, stepExecutionId: ref.stepExecutionId, disposition, branch, outputs, basis});
      },
    });
  }

  link(from: ExecutionFlowOccurrenceRef, to: ExecutionFlowOccurrenceRef, relation: ExecutionFlowLinkKind, transitionId: string | null = null, establishedBy: ExecutionFlowSubjectRef | null = null): void {
    this.emit({kind: "link", from, to, relation, transitionId, establishedBy});
  }
  close(disposition: ExecutionFlowDisposition, exit: ExecutionFlowOccurrenceRef | null = null, subjects: readonly ExecutionFlowSubjectRef[] = []): void {
    if (this.closed) return;
    this.emit({kind: "invocation_exited", disposition, exit, subjects});
    this.closed = true;
  }

  private emit(value: UnstampedObservation): void {
    if (this.closed || !this.context.observer) return;
    try { this.publish({...value, definition: this.definitionRef, runId: this.runId, invocationId: this.ref.invocationId, sequence: ++this.sequence, occurredAt: this.now()} as ExecutionFlowObservation); } catch { /* Observation cannot control execution. */ }
  }
  private publish(value: ExecutionFlowObservation): void {
    if (!this.context.observer) return;
    try { void Promise.resolve(this.context.observer.observe(freeze(JSON.parse(JSON.stringify(value))))).catch(() => {}); } catch { /* Passive diagnostic consumer. */ }
  }
}
type WithoutStamp<T> = T extends FlowFact ? Omit<T, keyof FlowFact> : never;
type UnstampedObservation = WithoutStamp<ExecutionFlowObservation>;
export interface ExecutionFlowStep {
  readonly ref: ExecutionFlowOccurrenceRef;
  readonly context: ExecutionFlowContext;
  check(checkId: string, disposition: Extract<ExecutionFlowObservation, {kind: "constraint"}>["disposition"], basis?: ExecutionFlowBasis, configuration?: ExecutionFlowSubjectRef | null): void;
  end(disposition?: ExecutionFlowDisposition, basis?: ExecutionFlowBasis, branch?: string | null, outputs?: readonly ExecutionFlowSubjectRef[]): void;
}

/** An owner-local serial path. Concurrent branches use distinct invocations. */
export class ExecutionFlowPath<TStep extends string = string> extends ExecutionFlowInvocation<TStep> {
  current: ExecutionFlowStep | null = null;
  private stepId: string | null = null;
  advance(stepId: TStep, basis: ExecutionFlowBasis = {}, inputs: readonly ExecutionFlowSubjectRef[] = []): ExecutionFlowStep {
    const previous = this.current;
    const previousId = this.stepId;
    previous?.end("returned", {}, stepId);
    const step = this.enter(stepId, {basis, inputs});
    if (previous && previousId) {
      const transition = this.definition.transitions.find(edge => edge.from === previousId && edge.to === stepId);
      this.link(previous.ref, step.ref, "next", transition?.id ?? null);
    }
    this.stepId = stepId;
    this.current = step;
    return step;
  }
  get callContext(): ExecutionFlowContext { return this.current?.context ?? this.context; }
  override close(disposition: ExecutionFlowDisposition, exit = this.current?.ref ?? null, subjects: readonly ExecutionFlowSubjectRef[] = []): void {
    this.current?.end(disposition, {}, null, subjects);
    // Spawned work finishing does not establish that its caller consumed it.
    if (this.context.caller && this.context.relationship !== "spawn") this.link(exit ?? this.ref, this.context.caller, "return");
    super.close(disposition, exit, subjects);
  }
}

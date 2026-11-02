/** Owner-declared diagnostic relationships, not another owner of execution state. */
export interface ContextProcessObjectRef {
  readonly owner: string;
  readonly id: string;
  readonly runId: string | null;
  readonly revision: string | null;
}

export interface ContextProcessRelationship {
  readonly kind: "observes" | "produces" | "includes" | "transforms" | "settles" | "delivers" | "prerequisite";
  readonly from: ContextProcessObjectRef;
  readonly to: ContextProcessObjectRef;
  readonly condition: "result" | null;
  readonly operation: string | null;
}

export interface ContextProcessEvidence {
  readonly revision: "1";
  readonly category: "decision" | "measurement" | "representation" | "selection" | "delivery" | "material" | "responsibility";
  readonly subject: ContextProcessObjectRef;
  /** Explicit original use scope. Omission means this owner has not supplied it. */
  readonly scope?: {readonly purpose:string|null;readonly recipient:{readonly runId:string;readonly recipient:string;readonly purpose:string}|null};
  /** Counts declared at their owning boundary; eligibility is not actual consumption or savings. */
  readonly reuse?: {readonly eligibility?:number;readonly content?:number;readonly checks?:number;readonly input?:number;readonly basis:string};
  /** Null means the fact observes this object without changing its lifecycle. */
  readonly state: {readonly phase: "pending" | "settled"; readonly status: string} | null;
  /** Original professional judgment, not a classification inferred by an observer. */
  readonly judgment?: {
    readonly foreground:string;readonly investment:string;readonly adoption:string|null;readonly reason:string|null;
    readonly reconsiderOn:readonly string[];readonly limitations:readonly string[];
    readonly excluded:readonly {readonly optionId:string;readonly reasons:readonly string[]}[];
  };
  readonly relationships: readonly ContextProcessRelationship[];
  /** Related owner facts are observations, never inferred executions or deliveries. */
  readonly related: readonly {
    readonly subject: ContextProcessObjectRef;
    readonly name: string;
    readonly occurredAt: string | null;
    readonly value: unknown;
  }[];
}

export function contextProcessObject(owner: string, id: string, runId: string | null, revision: string | null = null): ContextProcessObjectRef {
  return {owner, id, runId, revision};
}

export function contextProcessRelationship(kind: ContextProcessRelationship["kind"], from: ContextProcessObjectRef,
  to: ContextProcessObjectRef, operation: string | null = null): ContextProcessRelationship {
  return {kind, from, to, condition: kind === "prerequisite" ? "result" : null, operation};
}

export function validateContextProcessEvidence(input: unknown): asserts input is ContextProcessEvidence {
  const value = input as ContextProcessEvidence;
  const token = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  const ref = (v: ContextProcessObjectRef): void => {
    if (!v || !token(v.owner) || !token(v.id) || v.runId !== null && !token(v.runId) || v.revision !== null && !token(v.revision)) {
      throw new TypeError("context_process_reference_invalid");
    }
  };
  if (!value || value.revision !== "1" || !["decision", "measurement", "representation", "selection", "delivery", "material", "responsibility"].includes(value.category) ||
    !Array.isArray(value.relationships) || !Array.isArray(value.related)) throw new TypeError("context_process_evidence_invalid");
  ref(value.subject);
  if(value.reuse&&(!token(value.reuse.basis)||[value.reuse.eligibility,value.reuse.content,value.reuse.checks,value.reuse.input].some(v=>v!==undefined&&(!Number.isSafeInteger(v)||v<0))))throw new TypeError("context_process_reuse_invalid");
  if(value.judgment){const j=value.judgment;
    if(!token(j.foreground)||!token(j.investment)||j.adoption!==null&&!token(j.adoption)||j.reason!==null&&!token(j.reason)||
      !Array.isArray(j.reconsiderOn)||!j.reconsiderOn.every(token)||!Array.isArray(j.limitations)||!j.limitations.every(token)||
      !Array.isArray(j.excluded)||!j.excluded.every(o=>token(o.optionId)&&Array.isArray(o.reasons)&&o.reasons.every(token)))throw new TypeError("context_process_judgment_invalid");
  }
  if(value.scope&&((value.scope.purpose!==null&&!token(value.scope.purpose))||value.scope.recipient!==null&&
    (!token(value.scope.recipient?.runId)||!token(value.scope.recipient?.recipient)||!token(value.scope.recipient?.purpose))))throw new TypeError("context_process_scope_invalid");
  if (value.state !== null && (!value.state || !["pending", "settled"].includes(value.state.phase) || !token(value.state.status))) {
    throw new TypeError("context_process_state_invalid");
  }
  for (const edge of value.relationships) {
    if (!edge || !["observes", "produces", "includes", "transforms", "settles", "delivers", "prerequisite"].includes(edge.kind) ||
      edge.condition !== (edge.kind === "prerequisite" ? "result" : null) || edge.operation !== null && !token(edge.operation)) {
      throw new TypeError("context_process_relationship_invalid");
    }
    ref(edge.from); ref(edge.to);
  }
  for (const related of value.related) {
    ref(related.subject);
    if (!token(related.name) || related.value === undefined || related.occurredAt !== null &&
      (!token(related.occurredAt) || !Number.isFinite(Date.parse(related.occurredAt)))) throw new TypeError("context_process_related_fact_invalid");
  }
}

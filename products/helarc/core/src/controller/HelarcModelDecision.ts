export type HelarcModelPlanStepStatus = "pending" | "in_progress" | "completed";

export interface HelarcModelPlanStep {
  readonly step: string;
  readonly status: HelarcModelPlanStepStatus;
}

export type HelarcModelDecision =
  | {
      readonly kind: "tool_call";
      readonly toolName: string;
      readonly input: Readonly<Record<string, unknown>>;
      readonly reason?: string;
    }
  | {
      readonly kind: "plan_update";
      readonly plan: readonly HelarcModelPlanStep[];
      readonly explanation?: string;
    }
  | { readonly kind: "completion"; readonly summary: string }
  | { readonly kind: "stop"; readonly reason: string };

export type HelarcModelDecisionErrorCode =
  | "model_decision_invalid"
  | "model_decision_kind_invalid"
  | "model_decision_field_invalid"
  | "model_decision_tool_input_invalid"
  | "model_decision_plan_invalid";

export class HelarcModelDecisionError extends TypeError {
  constructor(
    readonly code: HelarcModelDecisionErrorCode,
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "HelarcModelDecisionError";
  }
}

const PLAN_STATUSES = new Set<HelarcModelPlanStepStatus>([
  "pending",
  "in_progress",
  "completed",
]);

export function parseHelarcModelDecision(input: unknown): HelarcModelDecision {
  const decision = exactRecord(input, "decision", [
    "kind",
    "toolName",
    "input",
    "reason",
    "plan",
    "explanation",
    "summary",
  ]);

  switch (decision.kind) {
    case "tool_call":
      exactKeys(decision, "decision", ["kind", "toolName", "input", "reason"]);
      return Object.freeze({
        kind: "tool_call" as const,
        toolName: text(decision.toolName, "decision.toolName", 256),
        input: snapshotJsonRecord(decision.input, "decision.input"),
        ...(decision.reason === undefined
          ? {}
          : { reason: text(decision.reason, "decision.reason", 4_096) }),
      });

    case "plan_update":
      exactKeys(decision, "decision", ["kind", "plan", "explanation"]);
      return Object.freeze({
        kind: "plan_update" as const,
        plan: snapshotPlan(decision.plan),
        ...(decision.explanation === undefined
          ? {}
          : { explanation: text(decision.explanation, "decision.explanation", 4_096) }),
      });

    case "completion":
      exactKeys(decision, "decision", ["kind", "summary"]);
      return Object.freeze({
        kind: "completion" as const,
        summary: text(decision.summary, "decision.summary", 64_000),
      });

    case "stop":
      exactKeys(decision, "decision", ["kind", "reason"]);
      return Object.freeze({
        kind: "stop" as const,
        reason: text(decision.reason, "decision.reason", 4_096),
      });

    default:
      throw fail(
        "model_decision_kind_invalid",
        "Helarc model decision kind is unsupported.",
        "decision.kind",
      );
  }
}

function snapshotPlan(input: unknown): readonly HelarcModelPlanStep[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 64) {
    throw fail(
      "model_decision_plan_invalid",
      "Plan must contain between one and 64 steps.",
      "decision.plan",
    );
  }

  let activeSteps = 0;
  const plan = input.map((candidate, index) => {
    const path = `decision.plan[${index}]`;
    const step = exactRecord(candidate, path, ["step", "status"]);
    exactKeys(step, path, ["step", "status"]);
    if (!PLAN_STATUSES.has(step.status as HelarcModelPlanStepStatus)) {
      throw fail(
        "model_decision_plan_invalid",
        "Plan step status is unsupported.",
        `${path}.status`,
      );
    }
    if (step.status === "in_progress") activeSteps += 1;
    return Object.freeze({
      step: text(step.step, `${path}.step`, 4_096),
      status: step.status as HelarcModelPlanStepStatus,
    });
  });

  if (activeSteps > 1) {
    throw fail(
      "model_decision_plan_invalid",
      "At most one Plan step can be in progress.",
      "decision.plan",
    );
  }
  return Object.freeze(plan);
}

function snapshotJsonRecord(
  input: unknown,
  path: string,
): Readonly<Record<string, unknown>> {
  const record = plainRecord(input, path, "model_decision_tool_input_invalid");
  return snapshotJson(record, path, new WeakSet()) as Readonly<Record<string, unknown>>;
}

function snapshotJson(
  input: unknown,
  path: string,
  ancestors: WeakSet<object>,
): unknown {
  if (input === null || typeof input === "string" || typeof input === "boolean") {
    return input;
  }
  if (typeof input === "number" && Number.isFinite(input)) return input;
  if (typeof input !== "object") {
    throw fail(
      "model_decision_tool_input_invalid",
      "Tool input must be JSON serializable.",
      path,
    );
  }
  if (ancestors.has(input)) {
    throw fail(
      "model_decision_tool_input_invalid",
      "Tool input cannot contain cycles.",
      path,
    );
  }
  ancestors.add(input);
  try {
    if (Array.isArray(input)) {
      return Object.freeze(input.map((item, index) =>
        snapshotJson(item, `${path}[${index}]`, ancestors)
      ));
    }
    const record = plainRecord(input, path, "model_decision_tool_input_invalid");
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (["__proto__", "constructor", "prototype"].includes(key)) {
        throw fail(
          "model_decision_tool_input_invalid",
          "Tool input contains a forbidden key.",
          `${path}.${key}`,
        );
      }
      result[key] = snapshotJson(record[key], `${path}.${key}`, ancestors);
    }
    return Object.freeze(result);
  } finally {
    ancestors.delete(input);
  }
}

function exactRecord(
  input: unknown,
  path: string,
  allowed: readonly string[],
): Record<string, unknown> {
  const record = plainRecord(input, path, "model_decision_invalid");
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw fail(
        "model_decision_field_invalid",
        `Unsupported model decision field '${key}'.`,
        `${path}.${key}`,
      );
    }
  }
  return record;
}

function exactKeys(
  record: Record<string, unknown>,
  path: string,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw fail(
        "model_decision_field_invalid",
        `Field '${key}' is not valid for '${String(record.kind)}'.`,
        `${path}.${key}`,
      );
    }
  }
}

function plainRecord(
  input: unknown,
  path: string,
  code: HelarcModelDecisionErrorCode,
): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw fail(code, "A plain object is required.", path);
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw fail(code, "A plain object is required.", path);
  }
  return input as Record<string, unknown>;
}

function text(input: unknown, path: string, maximum: number): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input !== input.trim() ||
    input.length > maximum
  ) {
    throw fail(
      "model_decision_field_invalid",
      "A bounded non-empty string is required.",
      path,
    );
  }
  return input;
}

function fail(
  code: HelarcModelDecisionErrorCode,
  message: string,
  path: string,
): HelarcModelDecisionError {
  return new HelarcModelDecisionError(code, message, path);
}

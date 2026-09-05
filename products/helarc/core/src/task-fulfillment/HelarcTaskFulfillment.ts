import type { RunRef } from "@agent-anything/agent-core/run";
import type {
  AgentDecisionCandidateRef,
  AgentHookEventRef,
} from "@agent-anything/agent-hooks/events";

export type HelarcTaskFulfillmentStatus = "fulfilled" | "incomplete" | "uncertain";

export type HelarcTaskFulfillmentFindingKind =
  | "missing_outcome"
  | "objective_mismatch"
  | "unsupported_claim"
  | "uncertainty";

export interface HelarcTaskFulfillmentFinding {
  readonly kind: HelarcTaskFulfillmentFindingKind;
  readonly code: string;
  readonly message: string;
}

export interface HelarcTaskFulfillmentAssessment {
  readonly id: string;
  readonly revision: string;
  readonly hookRevision: string;
  readonly event: AgentHookEventRef;
  readonly run: RunRef;
  readonly controllerRequestId: string;
  readonly task: Readonly<{ readonly id: string; readonly kind: string }>;
  readonly candidate: AgentDecisionCandidateRef;
  readonly status: HelarcTaskFulfillmentStatus;
  readonly disposition: "allow" | "continue";
  readonly rationale: string;
  readonly findings: readonly HelarcTaskFulfillmentFinding[];
  readonly feedback: string | null;
  readonly assessedAt: string;
}

export function snapshotHelarcTaskFulfillmentAssessment(
  input: HelarcTaskFulfillmentAssessment,
): HelarcTaskFulfillmentAssessment {
  if (input.status !== "fulfilled" && input.status !== "incomplete" && input.status !== "uncertain") {
    throw new TypeError("Helarc Task Fulfillment status is unsupported.");
  }
  if (!Array.isArray(input.findings) || input.findings.length > 32) {
    throw new TypeError("Helarc Task Fulfillment findings must be bounded.");
  }
  if (input.status === "fulfilled" && (input.findings.length > 0 || input.feedback !== null)) {
    throw new TypeError("A fulfilled Helarc Task assessment cannot carry unresolved findings or feedback.");
  }
  if (input.disposition !== "allow" && input.disposition !== "continue") {
    throw new TypeError("Helarc Stop disposition is unsupported.");
  }
  if ((input.disposition === "continue") !== (input.feedback !== null)) {
    throw new TypeError("Only a continuation disposition requires feedback.");
  }
  return deepFreeze({
    ...input,
    findings: input.findings.map((finding) => ({ ...finding })),
  });
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

import {
  snapshotDescendantContinuationCorrelation,
  type DescendantContinuationCorrelation,
} from "@agent-anything/agent-core/delegation";
import { boundedText, deepFreeze, strictRecord, token } from "./DelegationContract.js";

export interface DescendantMessageRequest {
  readonly agent_id: string;
  readonly prompt: string;
}

export interface DescendantContinuationTargetProjection {
  readonly ref: Readonly<{ readonly id: string; readonly revision: string }>;
  readonly sourceChild: Readonly<{ readonly id: string }>;
  readonly sourceResult: Readonly<{ readonly id: string; readonly revision: string }>;
  readonly agent: Readonly<{ readonly id: string; readonly revision: string }>;
  readonly limitations: readonly string[];
}

export interface ActiveDescendantTargetProjection {
  readonly target: Readonly<{ readonly kind: "active"; readonly id: string }>;
  readonly relation: Readonly<{ readonly id: string }>;
  readonly relationKind: "delegation" | "continuation";
  readonly agent: Readonly<{ readonly id: string; readonly revision: string }>;
  readonly runRevision: number;
  readonly status: "initializing" | "running" | "waiting" | "cancelling";
}

export interface DescendantTargetsProjection {
  readonly active: readonly ActiveDescendantTargetProjection[];
  readonly continuations: readonly DescendantContinuationTargetProjection[];
}

export function snapshotDescendantMessageRequest(
  input: DescendantMessageRequest,
): DescendantMessageRequest {
  strictRecord(input, "DescendantMessageRequest", ["agent_id", "prompt"]);
  return deepFreeze({
    agent_id: token(input.agent_id, "DescendantMessageRequest.agent_id"),
    prompt: boundedText(
      input.prompt,
      "DescendantMessageRequest.prompt",
      64_000,
    ),
  });
}

export function createDescendantContinuationTargetProjection(input: {
  readonly correlation: DescendantContinuationCorrelation;
  readonly limitations?: readonly string[];
}): DescendantContinuationTargetProjection {
  const correlation = snapshotDescendantContinuationCorrelation(input.correlation);
  const limitations = (input.limitations ?? []).map((value, index) =>
    token(value, `DescendantContinuationTargetProjection.limitations[${index}]`)
  );
  if (new Set(limitations).size !== limitations.length) {
    throw new TypeError("Continuation target limitations must be unique.");
  }
  return deepFreeze({
    ref: correlation.ref,
    sourceChild: correlation.sourceChild,
    sourceResult: correlation.sourceResult,
    agent: correlation.agent,
    limitations,
  });
}

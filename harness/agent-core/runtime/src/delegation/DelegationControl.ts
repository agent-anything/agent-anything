import {
  snapshotDelegationRequestRef,
  type DelegationRequestRef,
} from "@agent-anything/agent-core/delegation";
import type { RunRef } from "@agent-anything/agent-core/run";
import type { DescendantRunRelationRef } from "@agent-anything/agent-core/run-tree";
import {
  snapshotRunResumeRequestInput,
  snapshotRunSteeringInput,
  type RunResumeReceipt,
  type RunResumeRequestInput,
  type RunSteeringInput,
  type RunSteeringSubmissionReceipt,
} from "../run/index.js";
import { deepFreeze, strictRecord, token } from "./DelegationContract.js";
import type {DelegatedCancellationBasis,RunCancellationReceipt} from "../run/RunCancellation.js";

export interface DelegationCancelRoute {
  readonly basis: DelegatedCancellationBasis;
  readonly attribution: {readonly origin:"user";readonly reasonCode:"user_requested"} | {readonly origin:"host";readonly reasonCode:"host_requested"};
  readonly reason: string|null;
}
export type DelegationCancelReceipt =
  | {readonly status:"routed";readonly cancellation:RunCancellationReceipt}
  | {readonly status:"rejected";readonly code:DelegationSteeringRejectionCode};

export interface DelegationSteeringRoute {
  readonly request: DelegationRequestRef;
  readonly relation: DescendantRunRelationRef;
  readonly child: RunRef;
  readonly steering: RunSteeringInput;
}

export interface DelegationResumeRoute {
  readonly request: DelegationRequestRef;
  readonly relation: DescendantRunRelationRef;
  readonly child: RunRef;
  readonly resume: RunResumeRequestInput;
}

export type DelegationSteeringRejectionCode =
  | "delegation_route_invalid"
  | "delegation_relation_unknown"
  | "delegation_route_mismatch"
  | "delegation_child_settled";

export type DelegationSteeringReceipt =
  | {
      readonly status: "routed";
      readonly relation: DescendantRunRelationRef;
      readonly child: RunRef;
      readonly submission: RunSteeringSubmissionReceipt;
    }
  | {
      readonly status: "rejected";
      readonly code: DelegationSteeringRejectionCode;
      readonly relation: DescendantRunRelationRef | null;
      readonly child: RunRef | null;
    };

export type DelegationResumeReceipt =
  | {
      readonly status: "routed";
      readonly relation: DescendantRunRelationRef;
      readonly child: RunRef;
      readonly resume: RunResumeReceipt;
    }
  | {
      readonly status: "rejected";
      readonly code: DelegationSteeringRejectionCode;
      readonly relation: DescendantRunRelationRef | null;
      readonly child: RunRef | null;
    };

export function snapshotDelegationSteeringRoute(
  input: DelegationSteeringRoute,
): DelegationSteeringRoute {
  strictRecord(input, "DelegationSteeringRoute", [
    "request",
    "relation",
    "child",
    "steering",
  ]);
  strictRecord(input.relation, "DelegationSteeringRoute.relation", ["id"]);
  strictRecord(input.child, "DelegationSteeringRoute.child", ["id"]);
  return deepFreeze({
    request: snapshotDelegationRequestRef(input.request),
    relation: { id: token(input.relation.id, "relation.id") },
    child: { id: token(input.child.id, "child.id") },
    steering: snapshotRunSteeringInput(input.steering),
  });
}

export function snapshotDelegationResumeRoute(
  input: DelegationResumeRoute,
): DelegationResumeRoute {
  strictRecord(input, "DelegationResumeRoute", [
    "request",
    "relation",
    "child",
    "resume",
  ]);
  strictRecord(input.relation, "DelegationResumeRoute.relation", ["id"]);
  strictRecord(input.child, "DelegationResumeRoute.child", ["id"]);
  return deepFreeze({
    request: snapshotDelegationRequestRef(input.request),
    relation: { id: token(input.relation.id, "relation.id") },
    child: { id: token(input.child.id, "child.id") },
    resume: snapshotRunResumeRequestInput(input.resume),
  });
}

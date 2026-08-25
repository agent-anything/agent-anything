import {
  snapshotDelegationRequestRef,
  type DelegationRequestRef,
} from "@agent-anything/agent-core/delegation";
import type { RunRef } from "@agent-anything/agent-core/run";
import type { DescendantRunRelationRef } from "@agent-anything/agent-core/run-tree";
import { snapshotRunSteeringInput, type RunSteeringInput } from "../run/index.js";
import { deepFreeze, strictRecord, token } from "./DelegationContract.js";

export interface DelegationSteeringRoute {
  readonly request: DelegationRequestRef;
  readonly relation: DescendantRunRelationRef;
  readonly child: RunRef;
  readonly steering: RunSteeringInput;
}

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

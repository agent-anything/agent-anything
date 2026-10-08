import { describe, expect, it } from "vitest";
import type { PreparedAction } from "@agent-anything/action-execution/registration";
import type { CanonicalActionSettlement } from "@agent-anything/canonical-action/settlement";
import { createHelarcLocalFileActionCapability } from "./LocalFileActionCapability.js";

describe("LocalFileActionCapability approval rejection", () => {
  it("preserves quota facts and their description through every file adapter", async () => {
    const capability = createHelarcLocalFileActionCapability({workspace: null});
    const detail = {kind: "capacity", stage: "approval_admission", scope: {owner: "agent-runtime", kind: "run_tree"},
      limit: {name: "total_requests", count: 8, maximum: 8}, dispatch: "never_dispatched",
      description: "Approval capacity reached; action was never dispatched."} as const;
    for (const {adapter} of capability.adapters) {
      const registration = capability.registrations.registrations.find(item => item.adapter.id === adapter.descriptor.id)!;
      const action = {id: "not-dispatched"};
      const settlement: CanonicalActionSettlement = {
        ref: {action, id: "settlement"}, action, subject: {action, revision: 1},
        operationInvocation: {id: "invocation", operation: registration.operation}, binding: registration.binding,
        status: "failed", attempts: [], effectCertainty: "none", completionExtent: "none", payload: null,
        causeOwner: "agent-runtime", causeRef: "approval_tree_total_limit_exceeded", failureDetail: detail,
        reconciliationRequired: false, settledAt: "2026-10-08T00:00:00.000Z",
      };
      const result = await adapter.settle({} as PreparedAction, settlement);
      expect(result).toMatchObject({status: "failed", output: null, failure: {
        owner: "agent-runtime", code: settlement.causeRef, message: detail.description, detail,
      }});
    }
  });
});

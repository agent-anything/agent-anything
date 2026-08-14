import type {
  OperationBindingRevisionRef,
  OperationRevisionRef,
} from "@agent-anything/operation-catalog/identity";
import { describe, expect, it } from "vitest";
import { createHelarcLocalCommandActionCapability } from "./LocalCommandActionCapability.js";

describe("createHelarcLocalCommandActionCapability", () => {
  it("binds the physical adapter to the Operation identity supplied by trusted composition", async () => {
    const operation: OperationRevisionRef = {
      operation: { namespace: "test-product", name: "run-command" },
      revision: "7",
    };
    const binding: OperationBindingRevisionRef = {
      operation,
      revision: "3",
    };

    const capability = await createHelarcLocalCommandActionCapability({
      workspace: null,
      operation,
      binding,
      environment: {},
    });

    expect(capability.registrations.registrations).toHaveLength(1);
    expect(capability.registrations.registrations[0]).toMatchObject({
      operation,
      binding,
      effectFamilies: ["process"],
      adapter: { id: capability.actionAdapterId },
    });
  });
});

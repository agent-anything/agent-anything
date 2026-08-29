import type {
  OperationBindingRevisionRef,
  OperationRevisionRef,
} from "@agent-anything/operation-catalog/identity";
import { describe, expect, it } from "vitest";
import { createHelarcLocalCommandActionCapability } from "./LocalCommandActionCapability.js";

describe("createHelarcLocalCommandActionCapability", () => {
  it("binds the physical adapter to the Operation identity supplied by trusted composition", async () => {
    const shellOperation: OperationRevisionRef = {
      operation: { namespace: "test-product", name: "shell" },
      revision: "7",
    };
    const shellBinding: OperationBindingRevisionRef = {
      operation: shellOperation,
      revision: "3",
    };
    const taskStopOperation: OperationRevisionRef = {
      operation: { namespace: "test-product", name: "task-stop" },
      revision: "2",
    };
    const taskStopBinding: OperationBindingRevisionRef = {
      operation: taskStopOperation,
      revision: "1",
    };

    const capability = await createHelarcLocalCommandActionCapability({
      workspace: {
        primary: {
          id: "workspace",
          name: "Workspace",
          rootRef: process.cwd(),
          trustState: "trusted",
          source: "test",
          policyRefs: [],
          metadata: {},
        },
        additional: [],
      },
      platform: "win32",
      shellOperation,
      shellBinding,
      taskStopOperation,
      taskStopBinding,
      environment: {},
    });

    expect(capability.registrations.registrations).toHaveLength(2);
    expect(capability.registrations.registrations[0]).toMatchObject({
      operation: shellOperation,
      binding: shellBinding,
      effectFamilies: ["filesystem", "process"],
      adapter: { id: capability.shellActionAdapterId },
    });
    expect(capability.registrations.registrations[1]).toMatchObject({
      operation: taskStopOperation,
      binding: taskStopBinding,
      adapter: { id: capability.taskStopActionAdapterId },
    });
  });
});

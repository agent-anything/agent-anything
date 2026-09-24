import type {
  OperationBindingRevisionRef,
  OperationRevisionRef,
} from "@agent-anything/operation-catalog/identity";
import type { PreparedAction } from "@agent-anything/action-execution/registration";
import type { CanonicalActionSettlement } from "@agent-anything/canonical-action/settlement";
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHelarcLocalCommandActionCapability } from "./LocalCommandActionCapability.js";

const NOW = "2026-08-29T00:00:00.000Z";
const commandOutputDirectory = mkdtempSync(join(tmpdir(), "helarc-action-output-"));
afterAll(() => rm(commandOutputDirectory, { recursive: true, force: true }));

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
      commandOutputDirectory,
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
      platform: process.platform === "win32" ? "win32":"posix",
      initialObservationHandlerId:"test.initial",taskOutputHandlerId:"test.output",
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
      effectFamilies: ["process"],
      adapter: { id: capability.shellActionAdapterId },
    });
    expect(capability.registrations.registrations[1]).toMatchObject({
      operation: taskStopOperation,
      binding: taskStopBinding,
      adapter: { id: capability.taskStopActionAdapterId },
    });
  });

  it("settles startup without pretending that command execution has finished", async () => {
    const capability=await createCapability();
    const adapter=capability.adapters[0]!.adapter;
    const settlement=shellSettlement();
    const result=await adapter.settle(shellPreparedAction("PowerShell","command"),settlement);
    expect(result.status).toBe("succeeded");
    expect(result.settlement).toBe(settlement);
    expect(result.output).toEqual(settlement.payload!.value);
    expect(capability.registrations.registrations[0]!.executionLifetime).toBe("run");
  });

  it("keeps Shell sessions separate for Root and Child Runs", async () => {
    const capability=await createCapability();
    expect(capability.shellSession("root")).toEqual(capability.shellSession("child"));
    expect(capability.internalHandlers.map(handler=>handler.id)).toEqual(["test.initial","test.output"]);
  });

});

async function createCapability() {
  const shellOperation: OperationRevisionRef = {
    operation: { namespace: "test-product", name: "shell" },
    revision: "7",
  };
  const taskStopOperation: OperationRevisionRef = {
    operation: { namespace: "test-product", name: "task-stop" },
    revision: "2",
  };
  return createHelarcLocalCommandActionCapability({
    commandOutputDirectory,
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
    platform: process.platform === "win32" ? "win32":"posix",
    initialObservationHandlerId:"test.initial",taskOutputHandlerId:"test.output",
    shellOperation,
    shellBinding: { operation: shellOperation, revision: "3" },
    taskStopOperation,
    taskStopBinding: { operation: taskStopOperation, revision: "1" },
    environment: {},
  });
}

function shellPreparedAction(
  shell: "Bash" | "PowerShell",
  command: string,
): PreparedAction {
  return {
    semanticBasis: {
      shell,
      command,
      commandDisplay: command,
      cwdDisplay: "workspace:.",
    },
  } as unknown as PreparedAction;
}

function shellSettlement(): CanonicalActionSettlement {
  const operation = {
    operation: { namespace: "test-product", name: "shell" },
    revision: "7",
  };
  return {
    ref: { action: { id: "action-1" }, id: "settlement-1" },
    action: { id: "action-1" },
    subject: { action: { id: "action-1" }, revision: 1 },
    operationInvocation: { id: "operation-invocation-1", operation },
    binding: { operation, revision: "3" },
    status: "succeeded",
    attempts: [{ action: { id: "action-1" }, id: "attempt-1", ordinal: 1 }],
    effectCertainty: "confirmed",
    completionExtent: "complete",
    payload: {
      value: {
        task_id: "action-1:process",
        run_id: "run-1",
        action_id: "action-1",
        attempt_id: "attempt-1",
        snapshot: { phase: "running", outcome: null },
      },
      startedAt: NOW,
      finishedAt: NOW,
    },
    causeOwner: null,
    causeRef: null,
    reconciliationRequired: false,
    settledAt: NOW,
  };
}

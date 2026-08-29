import type {
  OperationBindingRevisionRef,
  OperationRevisionRef,
} from "@agent-anything/operation-catalog/identity";
import type { PreparedAction } from "@agent-anything/action-execution/registration";
import type { CanonicalActionSettlement } from "@agent-anything/canonical-action/settlement";
import { describe, expect, it } from "vitest";
import { createHelarcLocalCommandActionCapability } from "./LocalCommandActionCapability.js";

const NOW = "2026-08-29T00:00:00.000Z";

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

  it("keeps physical completion while reporting a nonzero command exit as semantic failure", async () => {
    const capability = await createCapability();
    const adapter = capability.adapters.find(
      (candidate) => candidate.adapter.descriptor.id === capability.shellActionAdapterId,
    )!.adapter;
    const settlement = shellSettlement(73, "The project already exists.");

    const result = await adapter.settle(
      shellPreparedAction("PowerShell", "dotnet new console --name HelloWorldApp"),
      settlement,
    );

    expect(result).toMatchObject({
      status: "failed",
      output: null,
      failure: {
        owner: "helarc.local-environment",
        code: "command_exit_nonzero",
      },
    });
    expect(result.failure?.message).toContain("exit code 73");
    expect(result.failure?.message).toContain("The project already exists.");
    expect(result.settlement).toBe(settlement);
    expect(result.settlement.status).toBe("succeeded");
  });

  it("reports a zero command exit as semantic success", async () => {
    const capability = await createCapability();
    const adapter = capability.adapters.find(
      (candidate) => candidate.adapter.descriptor.id === capability.shellActionAdapterId,
    )!.adapter;

    const result = await adapter.settle(
      shellPreparedAction("Bash", "dotnet run"),
      shellSettlement(0, ""),
    );

    expect(result).toMatchObject({
      status: "succeeded",
      output: {
        mode: "foreground",
        exit_code: 0,
        exit_interpretation: null,
      },
      failure: null,
    });
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

function shellSettlement(
  exitCode: number,
  stderr: string,
): CanonicalActionSettlement {
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
        mode: "foreground",
        exit_code: exitCode,
        signal: null,
        duration_ms: 10,
        stdout: stream(""),
        stderr: stream(stderr),
        final_working_directory: null,
        shell_session_revision: null,
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

function stream(text: string) {
  return {
    text,
    encoding: "utf-8",
    encoding_source: "utf8",
    integrity: "exact",
    replacement_count: 0,
    truncated: false,
    overflow_file: null,
  };
}

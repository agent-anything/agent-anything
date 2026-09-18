import type { HelarcMainSnapshot } from "../HelarcDesktopApi.js";
import { createHelarcRunTreeTestSnapshot } from "./HelarcRunTreeTestSnapshot.js";

export function createWorkbenchTestRun(input: {
  status?: "running" | "completed" | "failed" | "cancelled";
  runtimeStatus?: "completed" | "failed" | "cancelled";
  runTree?: NonNullable<HelarcMainSnapshot["run"]>["host"]["runTree"];
  activeDelegations?: NonNullable<HelarcMainSnapshot["run"]>["host"]["activeDelegations"];
  terminalCode?: NonNullable<
    NonNullable<HelarcMainSnapshot["run"]>["host"]["terminal"]
  >["code"];
} = {}): NonNullable<HelarcMainSnapshot["run"]> {
  const status = input.status ?? "running";
  const runtimeStatus = input.runtimeStatus ?? "completed";
  const terminal = status !== "running";
  const code = input.terminalCode ?? (status === "completed"
    ? "completion_accepted" as const
    : status === "cancelled"
      ? "runtime_cancelled" as const
      : "runtime_limit_exceeded" as const);
  const qualification = modelQualificationSnapshot();
  return {
    productRunId: "product-run-1",
    harnessRunId: "harness-run-1",
    display: { status, terminal, statusSource: "host" },
    host: {
      taskId: "task-1",
      startedAt: "2026-07-05T01:00:00.000Z",
      runRevision: 0,
      instructionBinding: null,
      runTree: input.runTree ?? rootRunTree(),
      activeDelegations: input.activeDelegations ?? [],
      continuationTargets: [],
      pendingInteractions: [],
      terminal: terminal
        ? {
            status,
            code,
            completedAt: "2026-07-05T01:00:01.000Z",
          }
        : null,
    },
    product: {
      presentationRevision: 0,
      phase: { kind: "none" },
      qualification,
      continuation: null,
      result: terminal
        ? {
            status: status === "completed" ? "completed" : status,
            qualification,
            output: {
              taskId: "task-1",
              workspace: {
                primaryId: "workspace",
                additionalIds: [],
              },
              agentSummary: "Terminal summary",
              source: { kind: "product_status" },
              runtimeStatus,
              enforcement: {
                selected: "disabled",
                status: "unisolated",
                code: null,
              },
              safeErrors: status === "completed"
                ? []
                : [{ code: code ?? "run_failed", message: "Terminal error" }],
            },
          }
        : null,
    },
  };
}

function modelQualificationSnapshot(): NonNullable<HelarcMainSnapshot["run"]>["product"]["qualification"] {
  return {
    providerKind: "ollama",
    modelId: "gemma4:e4b",
    modelIdentityStrength: "mutable_alias",
    status: "experimental",
    policy: "allow_experimental",
    experimentalUseSelected: true,
    scopes: [
      {
        scope: "agent_loop",
        applicability: "absent",
        outcome: null,
        decidedAt: null,
        limitations: [],
      },
    ],
    reasons: ["No current qualification decision covers the required scope."],
    toolGuidance: {
      releaseId: "helarc.tool-guidance",
      releaseRevision: "helarc.tool-guidance.v1",
      profileRevision: "helarc.tool-profile.v1",
    },
  };
}

function rootRunTree(): NonNullable<HelarcMainSnapshot["run"]>["host"]["runTree"] {
  return createHelarcRunTreeTestSnapshot({
    runId: "harness-run-1",
    revision: 1,
    startedAt: "2026-07-05T01:00:00.000Z",
    deadlineAt: "2026-07-05T01:01:00.000Z",
  });
}

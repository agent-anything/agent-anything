import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentTask,
  RunResult,
  TaskWorkspaceScope,
} from "@agent-anything/agent-core";
import {
  createFailedRunResult,
  createSucceededRunResult,
} from "@agent-anything/agent-core";
import {
  createHostRunResult,
  type HostRunResult,
} from "@agent-anything/agent-core/host";
import type { WorkspaceContext } from "@agent-anything/governance";
import { ToolRegistry } from "@agent-anything/tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CODE_AGENT_READ_FILE_TOOL,
  acceptPatch,
  applyAcceptedPatch,
  createPatchProposal,
  registerCodeAgentFileTools,
  type AcceptedPatchStatus,
  type PatchStatus,
  type ProposedPatchStatus,
  type ReadFileOutput,
  type RejectedPatchStatus,
} from "../index.js";

interface CodeEditTaskInput {
  rootName: string;
  path: string;
  proposedContent: string;
  summary: string;
  rationale: string;
}

interface CodeEditScenarioOutput {
  inspection: ReadFileOutput;
  patch: PatchStatus;
}

type ScenarioDecision = AcceptedPatchStatus | RejectedPatchStatus;

interface RunCodeEditScenarioInput {
  sessionId: string;
  task: AgentTask<CodeEditTaskInput>;
  decide: (
    proposal: ProposedPatchStatus,
  ) => ScenarioDecision | Promise<ScenarioDecision>;
  flow: string[];
}

const timestamp = "2026-06-20T14:00:00.000Z";

describe("Code-Agent scenario", () => {
  let fixtureRoot: string;
  let codeRoot: string;
  let docsRoot: string;

  beforeEach(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "agent-anything-scenario-"));
    codeRoot = join(fixtureRoot, "code");
    docsRoot = join(fixtureRoot, "docs");
    await mkdir(join(codeRoot, "src"), { recursive: true });
    await mkdir(docsRoot, { recursive: true });
    await writeFile(
      join(codeRoot, "src", "message.ts"),
      'export const message = "before";\n',
    );
    await writeFile(join(docsRoot, "README.md"), "Scenario docs\n");
  });

  afterEach(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it("inspects, proposes, accepts, applies, and returns host output", async () => {
    const flow: string[] = [];
    const task = createTask();

    const hostResult = await runCodeEditScenario({
      sessionId: "session-code-edit",
      task,
      flow,
      decide(proposal) {
        flow.push("accept");
        expect(proposal).toMatchObject({
          status: "proposed",
          proposal: {
            rootName: "code",
            workspaceId: "workspace-code",
            operation: {
              kind: "update",
              path: "src/message.ts",
              originalContent: {
                algorithm: "sha256",
                byteLength: 33,
              },
            },
          },
        });

        return acceptPatch(proposal, {
          reason: "Apply the reviewed change.",
          metadata: { source: "scenario-host" },
          now: () => timestamp,
        });
      },
    });

    expect(flow).toEqual(["inspect", "propose", "accept", "apply", "output"]);
    expect(hostResult).toMatchObject({
      sessionId: "session-code-edit",
      taskId: "task-code-edit",
      state: {
        status: "completed",
        runResult: {
          status: "succeeded",
          finalOutput: {
            inspection: {
              rootName: "code",
              workspaceId: "workspace-code",
              path: "src/message.ts",
              content: 'export const message = "before";\n',
            },
            patch: {
              status: "applied",
              result: {
                status: "applied",
                patchId: "patch-scenario",
              },
            },
          },
        },
      },
    });
    await expect(readFile(join(codeRoot, "src", "message.ts"), "utf8"))
      .resolves.toBe('export const message = "after";\n');
    await expect(readFile(join(docsRoot, "README.md"), "utf8"))
      .resolves.toBe("Scenario docs\n");
  });

  function createTask(): AgentTask<CodeEditTaskInput> {
    return {
      id: "task-code-edit",
      kind: "code.edit",
      input: {
        rootName: "code",
        path: join("src", "message.ts"),
        proposedContent: 'export const message = "after";\n',
        summary: "Update the example message",
        rationale: "Keep the fixture aligned with the requested result.",
      },
      createdAt: timestamp,
      metadata: { scenario: "phase6-code-edit" },
      workspaceScope: createWorkspaceScope(),
    };
  }

  function createWorkspaceScope(): TaskWorkspaceScope {
    return {
      roots: {
        code: createWorkspace("workspace-code", codeRoot),
        docs: createWorkspace("workspace-docs", docsRoot),
      },
      defaultRootName: "docs",
    };
  }
});

async function runCodeEditScenario(
  input: RunCodeEditScenarioInput,
): Promise<HostRunResult<CodeEditScenarioOutput>> {
  const workspaceScope = input.task.workspaceScope;
  if (workspaceScope === undefined) {
    throw new Error("Scenario task requires a workspace scope.");
  }

  const registry = new ToolRegistry();
  registerCodeAgentFileTools(registry, {
    workspaceScope,
    now: () => timestamp,
  });
  const inspectionResult = await registry.execute({
    id: "tool-call-inspect",
    toolName: CODE_AGENT_READ_FILE_TOOL,
    input: {
      rootName: input.task.input.rootName,
      path: input.task.input.path,
    },
    risk: "safe",
    metadata: { taskId: input.task.id },
  });
  if (inspectionResult.status !== "succeeded" || inspectionResult.output === null) {
    throw new Error("Scenario file inspection failed.");
  }
  const inspection = inspectionResult.output as ReadFileOutput;
  input.flow.push("inspect");

  const proposed = await createPatchProposal(
    {
      workspaceScope,
      rootName: input.task.input.rootName,
      change: {
        kind: "update",
        path: input.task.input.path,
        proposedContent: input.task.input.proposedContent,
      },
      summary: input.task.input.summary,
      rationale: input.task.input.rationale,
      metadata: { taskId: input.task.id },
    },
    {
      now: () => timestamp,
      createPatchId: () => "patch-scenario",
    },
  );
  input.flow.push("propose");

  const decision = await input.decide(proposed);
  let patch: PatchStatus;
  if (decision.status === "accepted") {
    patch = await applyAcceptedPatch({
      patch: decision,
      workspaceScope,
      now: () => timestamp,
    });
    input.flow.push("apply");
  } else {
    patch = decision;
  }

  const runResult = createScenarioRunResult(
    "run-code-edit",
    input.task.id,
    inspection,
    patch,
  );
  input.flow.push("output");

  return createHostRunResult({
    sessionId: input.sessionId,
    runResult,
    timestamp,
    metadata: { scenario: "phase6-code-edit" },
  });
}

function createScenarioRunResult(
  runId: string,
  taskId: string,
  inspection: ReadFileOutput,
  patch: PatchStatus,
): RunResult<CodeEditScenarioOutput> {
  const failedPatch = patch.status === "failed" ? patch : null;
  const base = {
    runId,
    taskId,
    metadata: { terminalPatchStatus: patch.status },
  };
  if (failedPatch === null) {
    return createSucceededRunResult(base, { inspection, patch });
  }

  return createFailedRunResult(base, "tool_execution_failed", [{
    owner: "tool",
    code: failedPatch.result.code,
    message: failedPatch.result.message,
    retryable: false,
    metadata: {
      patchId: failedPatch.proposal.id,
      patchCode: failedPatch.result.code,
    },
  }]);
}

function createWorkspace(id: string, rootRef: string): WorkspaceContext {
  return {
    id,
    name: id,
    rootRef,
    trustState: "trusted",
    source: "scenario",
    policyRefs: [],
    metadata: {},
  };
}

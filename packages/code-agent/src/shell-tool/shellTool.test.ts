import { access, mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TaskWorkspaceScope } from "@agent-anything/agent-core";
import type { WorkspaceContext } from "@agent-anything/governance";
import {
  ToolRegistry,
  type ToolCall,
  type ToolInvocationContext,
} from "@agent-anything/tools";
import {
  CODE_AGENT_RUN_COMMAND_TOOL,
  registerCodeAgentShellTool,
} from "./index.js";

describe("codeAgent.runCommand", () => {
  let testRoot: string;
  let codeRoot: string;
  let docsRoot: string;

  beforeEach(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "agent-anything-shell-"));
    codeRoot = join(testRoot, "code");
    docsRoot = join(testRoot, "docs");
    await mkdir(join(codeRoot, "src"), { recursive: true });
    await mkdir(docsRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  it("registers a risky structured process tool", () => {
    const registry = createRegistry();

    expect(registry.get(CODE_AGENT_RUN_COMMAND_TOOL)).toMatchObject({
      name: CODE_AGENT_RUN_COMMAND_TOOL,
      risk: "risky",
      metadata: {
        shell: false,
      },
    });
  });

  it("preserves args and executes in canonical selected cwd", async () => {
    const registry = createRegistry();

    const result = await registry.execute(createCall({
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write(process.argv[1] + '|' + process.cwd())",
        "hello world",
      ],
      rootName: "code",
      cwd: "src",
      reason: "Verify structured process execution.",
    }));

    expect(result).toMatchObject({
      status: "succeeded",
      output: {
        rootName: "code",
        workspaceId: "workspace-code",
        command: process.execPath,
        cwd: "src",
        exitCode: 0,
        signal: null,
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
      },
    });
    const expectedCwd = await realpath(join(codeRoot, "src"));
    expect((result.output as { stdout: string }).stdout)
      .toBe("hello world|" + expectedCwd);
  });

  it("returns nonzero exit as a completed command outcome", async () => {
    const registry = createRegistry();

    const result = await registry.execute(createCall({
      command: process.execPath,
      args: [
        "-e",
        "process.stderr.write('bad'); process.exit(7)",
      ],
      reason: "Verify nonzero exit handling.",
    }));

    expect(result).toMatchObject({
      status: "succeeded",
      output: {
        exitCode: 7,
        stderr: "bad",
        timedOut: false,
      },
    });
  });

  it("truncates stdout and stderr independently", async () => {
    const registry = createRegistry({
      maxStdoutBytes: 5,
      maxStderrBytes: 4,
    });

    const result = await registry.execute(createCall({
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write('abcdefgh'); process.stderr.write('1234567')",
      ],
      reason: "Verify bounded process output.",
    }));

    expect(result).toMatchObject({
      status: "succeeded",
      output: {
        stdout: "abcde",
        stderr: "1234",
        stdoutTruncated: true,
        stderrTruncated: true,
      },
    });
  });

  it("returns timeout status and captured output", async () => {
    const registry = createRegistry({
      defaultTimeoutMs: 500,
      maxTimeoutMs: 1_000,
    });

    const result = await registry.execute(createCall({
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write('started'); setTimeout(() => {}, 5000)",
      ],
      reason: "Verify timeout handling.",
    }));

    expect(result).toMatchObject({
      status: "timeout",
      output: null,
      error: {
        code: "shell_timeout",
        metadata: {
          stdout: "started",
          timeoutMs: 500,
        },
      },
    });
  });

  it("returns structured start failure", async () => {
    const registry = createRegistry();

    const result = await registry.execute(createCall({
      command: "agent-anything-command-that-does-not-exist",
      args: [],
      reason: "Verify process start failure.",
    }));

    expect(result).toMatchObject({
      status: "failed",
      error: {
        code: "shell_process_start_failed",
        message: "Failed to start or monitor the command process.",
      },
    });
  });

  it("terminates a running process and retains bounded output on cancellation", async () => {
    const registry = createRegistry({
      defaultTimeoutMs: 5_000,
      maxTimeoutMs: 5_000,
    });
    const controller = new AbortController();
    let interruption: ToolInvocationContext["interruption"]["interruption"] = null;
    const context = createInvocationContext(controller, () => interruption);

    const pending = registry.execute(createCall({
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write('started'); setTimeout(() => {}, 5000)",
      ],
      reason: "Verify command cancellation.",
    }), context);
    await new Promise((resolve) => setTimeout(resolve, 100));
    interruption = {
      kind: "run_cancellation",
      cancellation: { runId: "run-shell", requestId: "cancel-shell" },
    };
    controller.abort(new Error("cancel command"));

    const result = await pending;

    expect(result).toMatchObject({
      status: "interrupted",
      output: {
        interrupted: true,
        cancellationAttributed: true,
        settlementConfirmed: true,
        stdout: "started",
      },
      error: {
        code: "shell_cancelled",
        metadata: { runId: "run-shell", requestId: "cancel-shell" },
      },
    });
  });

  it("rejects invalid input and timeout above trusted maximum", async () => {
    const registry = createRegistry({
      defaultTimeoutMs: 50,
      maxTimeoutMs: 100,
    });

    const invalidArgs = await registry.execute(createCall({
      command: process.execPath,
      args: "not-an-array",
      reason: "Verify input validation.",
    }));
    const excessiveTimeout = await registry.execute(createCall({
      command: process.execPath,
      args: [],
      timeoutMs: 101,
      reason: "Verify timeout limit.",
    }));

    expect(invalidArgs).toMatchObject({
      status: "failed",
      error: { code: "shell_invalid_input" },
    });
    expect(excessiveTimeout).toMatchObject({
      status: "failed",
      error: { code: "shell_timeout_limit_exceeded" },
    });
  });

  it("rejects missing and escaping cwd", async () => {
    const outsideRoot = join(testRoot, "outside");
    await mkdir(outsideRoot);

    let linkCreated = true;
    try {
      await symlink(
        outsideRoot,
        join(codeRoot, "escape"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "EPERM"
      ) {
        linkCreated = false;
      } else {
        throw error;
      }
    }

    const registry = createRegistry();
    const missing = await registry.execute(createCall({
      command: process.execPath,
      args: [],
      cwd: "missing",
      reason: "Verify missing cwd.",
    }));

    expect(missing).toMatchObject({
      status: "failed",
      error: { code: "file_not_found" },
    });

    if (linkCreated) {
      const escaped = await registry.execute(createCall({
        command: process.execPath,
        args: [],
        cwd: "escape",
        reason: "Verify canonical cwd containment.",
      }));

      expect(escaped).toMatchObject({
        status: "failed",
        error: { code: "workspace_symlink_escape" },
      });
    }
  });

  function createRegistry(
    limits: Parameters<typeof registerCodeAgentShellTool>[1]["limits"] = {},
  ): TestToolRegistry {
    const registry = new TestToolRegistry();
    registerCodeAgentShellTool(registry, {
      workspaceScope: createScope(),
      limits,
    });
    return registry;
  }

  function createScope(): TaskWorkspaceScope {
    return {
      roots: {
        code: createWorkspace("workspace-code", codeRoot),
        docs: createWorkspace("workspace-docs", docsRoot),
      },
      defaultRootName: "code",
    };
  }
});

function createWorkspace(
  id: string,
  rootRef: string,
): WorkspaceContext {
  return {
    id,
    name: id,
    rootRef,
    trustState: "trusted",
    source: "test",
    policyRefs: [],
    metadata: {},
  };
}

class TestToolRegistry extends ToolRegistry {
  override execute(
    call: ToolCall,
    context: ToolInvocationContext = createInvocationContext(),
  ) {
    return super.execute(call, context);
  }
}

function createInvocationContext(
  controller = new AbortController(),
  getInterruption: () => ToolInvocationContext["interruption"]["interruption"] = () => null,
): ToolInvocationContext {
  return {
    interruption: {
      signal: controller.signal,
      get interruption() {
        return getInterruption();
      },
    },
    processTermination: {
      gracePeriodMs: 50,
      forceKillTimeoutMs: 1_000,
    },
  };
}

function createCall(input: unknown): ToolCall {
  return {
    id: "tool-call-shell",
    toolName: CODE_AGENT_RUN_COMMAND_TOOL,
    input,
    risk: "risky",
    metadata: {
      taskId: "task-shell",
    },
  };
}

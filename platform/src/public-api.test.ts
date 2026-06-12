import { describe, expect, it } from "vitest";
import {
  createAnonymousIdentityProvider,
  createAuditRecord,
  createDefaultRuntime,
  createDefaultWorkspaceResolver,
  createTelemetryRecord,
  FunctionToolAdapter,
  InMemoryStorage,
  Redactor,
  ReportTemplateRegistry,
  ReportTemplateRenderer,
  ToolRegistry,
  type AgentTask,
  type ToolDefinition,
} from "./index.js";
import * as publicApi from "./index.js";

describe("Phase1 public API", () => {
  it("runs the minimal Phase1 flow through public exports", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(createLookupDnsTool());

    const storage = new InMemoryStorage();
    const runtime = createDefaultRuntime({
      toolRegistry,
      permissionMode: "trusted",
      storage,
    });

    const task: AgentTask = {
      id: "task_001",
      kind: "net-doctor.diagnose",
      input: {
        toolCalls: [
          {
            id: "tool_call_001",
            toolName: "net.lookupDns",
            input: {
              hostname: "example.com",
              recordType: "A",
            },
            risk: "safe",
            metadata: {
              taskId: "task_001",
            },
          },
        ],
      },
      createdAt: "2026-06-04T00:00:00.000Z",
      metadata: {
        source: "public-api-test",
      },
    };

    const result = await runtime.run(task);

    expect(result.status).toBe("succeeded");
    expect(result.output).toBeNull();
    expect(result.outputSpec).toEqual({
      format: "json",
      metadata: {},
    });
    expect(result.evidenceRefs).toEqual(["evidence_tool_call_001"]);
    expect(result.errors).toEqual([]);
    expect(storage.getArtifact("artifact_evidence_evidence_tool_call_001")).toMatchObject({
      kind: "evidence",
      ref: "memory://evidence/evidence_tool_call_001",
    });
  });

  it("returns structured blocked result through public exports when permission denies a risky tool", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      ...createLookupDnsTool(),
      name: "shell.runCommand",
      risk: "risky",
    });

    const runtime = createDefaultRuntime({
      toolRegistry,
      permissionMode: "deny",
      storage: new InMemoryStorage(),
    });

    const result = await runtime.run({
      id: "task_001",
      kind: "net-doctor.diagnose",
      input: {
        toolCalls: [
          {
            id: "tool_call_001",
            toolName: "shell.runCommand",
            input: {
              command: "echo hello",
            },
            risk: "risky",
            metadata: {
              taskId: "task_001",
            },
          },
        ],
      },
      createdAt: "2026-06-04T00:00:00.000Z",
      metadata: {
        source: "public-api-test",
      },
    });

    expect(result).toMatchObject({
      status: "blocked",
      output: null,
      errors: [
        {
          code: "permission_mode_denied",
          metadata: {
            toolCallId: "tool_call_001",
            toolName: "shell.runCommand",
          },
        },
      ],
    });
  });

  it("uses injected permission service through public exports", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      ...createLookupDnsTool(),
      name: "shell.runCommand",
      risk: "risky",
    });

    const runtime = createDefaultRuntime({
      toolRegistry,
      permissionMode: "deny",
      storage: new InMemoryStorage(),
      permissionService: {
        async request(request) {
          return {
            requestId: request.id,
            status: "granted",
            reason: "Allowed by public API test service.",
            decidedAt: "2026-06-07T00:00:00.000Z",
          };
        },
      },
    });

    const result = await runtime.run({
      id: "task_001",
      kind: "net-doctor.diagnose",
      input: {
        toolCalls: [
          {
            id: "tool_call_001",
            toolName: "shell.runCommand",
            input: {
              command: "echo hello",
            },
            risk: "risky",
            metadata: {
              taskId: "task_001",
            },
          },
        ],
      },
      createdAt: "2026-06-04T00:00:00.000Z",
      metadata: {
        source: "public-api-test",
      },
    });

    expect(result.status).toBe("succeeded");
  });

  it("exposes report template APIs through public exports", () => {
    const registry = new ReportTemplateRegistry();
    const renderer = new ReportTemplateRenderer({ registry });

    expect(registry).toBeInstanceOf(ReportTemplateRegistry);
    expect(renderer).toBeInstanceOf(ReportTemplateRenderer);
  });

  it("exposes redaction APIs through public exports", () => {
    const redactor = new Redactor();

    expect(redactor.redact({
      value: {
        token: "secret",
      },
    })).toMatchObject({
      value: {
        token: "[REDACTED]",
      },
      redacted: true,
    });
  });

  it("exposes tool adapter APIs through public exports", async () => {
    const adapter = new FunctionToolAdapter({
      name: "example.echo",
      risk: "safe",
      handler(call) {
        return call.input;
      },
    });

    await expect(adapter.toToolDefinition().execute({
      id: "tool_call_001",
      toolName: "example.echo",
      input: {
        message: "hello",
      },
      risk: "safe",
      metadata: {},
    })).resolves.toMatchObject({
      status: "succeeded",
      output: {
        message: "hello",
      },
    });
  });

  it("exposes Phase3.1 audit, telemetry, workspace, and identity contracts", async () => {
    const auditRecord = createAuditRecord({
      id: "audit_001",
      taskId: "task_001",
      eventName: "task.completed",
      timestamp: "2026-06-12T00:00:00.000Z",
      subject: {
        kind: "user",
        id: "user_001",
        metadata: {},
      },
      action: "runtime.complete",
      target: {
        kind: "task",
        id: "task_001",
        metadata: {},
      },
      outcome: "succeeded",
    });
    const telemetryRecord = createTelemetryRecord({
      id: "telemetry_001",
      taskId: "task_001",
      eventName: "task.completed",
      timestamp: "2026-06-12T00:00:00.000Z",
      counters: {
        toolCalls: 1,
      },
    });
    const workspace = await createDefaultWorkspaceResolver().resolve({
      taskId: "task_001",
      cwd: "D:/projects/example",
      metadata: {},
    });
    const identity = await createAnonymousIdentityProvider().resolve({
      taskId: "task_001",
      metadata: {},
    });

    expect(auditRecord.outcome).toBe("succeeded");
    expect(telemetryRecord.counters.toolCalls).toBe(1);
    expect(workspace.id).toBe("workspace_local");
    expect(identity.kind).toBe("anonymous");
  });

  it("does not expose testing fakes through public exports", () => {
    expect("FakeAuditPort" in publicApi).toBe(false);
    expect("FakeTelemetryPort" in publicApi).toBe(false);
    expect("FakeWorkspaceResolver" in publicApi).toBe(false);
    expect("FakeIdentityProvider" in publicApi).toBe(false);
  });
});

function createLookupDnsTool(): ToolDefinition {
  return {
    name: "net.lookupDns",
    risk: "safe",
    async execute(call) {
      return {
        toolCallId: call.id,
        toolName: call.toolName,
        status: "succeeded",
        output: {
          hostname: "example.com",
          recordType: "A",
          records: ["93.184.216.34"],
        },
        error: null,
        startedAt: "2026-06-04T00:00:00.000Z",
        finishedAt: "2026-06-04T00:00:01.000Z",
        metadata: {
          adapter: "fake-dns",
        },
      };
    },
  };
}

import { describe, expect, it } from "vitest";
import { FakeAuditPort } from "./FakeAuditPort.js";
import { FakeIdentityProvider } from "./FakeIdentityProvider.js";
import { FakePermissionService } from "./FakePermissionService.js";
import { FakePolicyPort } from "./FakePolicyPort.js";
import { FakeTelemetryPort } from "./FakeTelemetryPort.js";
import { FakeWorkspaceResolver } from "./FakeWorkspaceResolver.js";

describe("testing fake ports", () => {
  it("records policy checks and permission requests", async () => {
    const policyPort = new FakePolicyPort();
    const permissionService = new FakePermissionService();

    await expect(policyPort.evaluate({
      id: "policy_check_001",
      subject: { kind: "user", id: "user_001", metadata: {} },
      target: { kind: "tool", id: "tool_001", metadata: {} },
      action: "execute",
      risk: "safe",
      workspace: null,
      metadata: {},
    })).resolves.toMatchObject({
      status: "allowed",
    });

    await expect(permissionService.request({
      id: "permission_request_001",
      toolCall: {
        id: "tool_call_001",
        toolName: "tool.lookup",
        input: {},
        risk: "safe",
        metadata: {},
      },
      reason: "Test permission.",
      risk: "safe",
      subject: null,
      workspace: null,
      metadata: {},
    })).resolves.toMatchObject({
      status: "granted",
    });

    expect(policyPort.checks).toHaveLength(1);
    expect(permissionService.requests).toHaveLength(1);
  });

  it("records audit and telemetry records", async () => {
    const auditPort = new FakeAuditPort();
    const telemetryPort = new FakeTelemetryPort();
    const context = {
      purpose: "runtime" as const,
      signal: new AbortController().signal,
      deadlineAt: null,
    };

    await auditPort.record({
      id: "audit_001",
      action: "tool.execute",
      outcome: "succeeded",
      subject: null,
      target: { kind: "tool", id: "tool_001", metadata: {} },
      createdAt: "2026-06-15T00:00:00.000Z",
      metadata: {},
    }, context);
    await telemetryPort.record({
      id: "telemetry_001",
      name: "tool.execution",
      createdAt: "2026-06-15T00:00:00.000Z",
      dimensions: {},
      counters: {},
      metadata: {},
    }, context);

    expect(auditPort.records).toHaveLength(1);
    expect(telemetryPort.records).toHaveLength(1);
  });

  it("resolves fixed workspace and identity contexts", async () => {
    const workspaceResolver = new FakeWorkspaceResolver({
      id: "workspace_001",
      kind: "local",
      rootPath: "D:/projects/agent-anything",
      metadata: {},
    });
    const identityProvider = new FakeIdentityProvider({
      id: "identity_001",
      kind: "user",
      displayName: "Test User",
      metadata: {},
    });

    await expect(workspaceResolver.resolve({
      taskId: "task_001",
      metadata: {},
    })).resolves.toMatchObject({
      id: "workspace_001",
    });
    await expect(identityProvider.resolve({
      taskId: "task_001",
      workspace: null,
      metadata: {},
    })).resolves.toMatchObject({
      id: "identity_001",
    });

    expect(workspaceResolver.requests).toHaveLength(1);
    expect(identityProvider.requests).toHaveLength(1);
  });
});

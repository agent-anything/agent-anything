import { describe, expect, it } from "vitest";
import { EvidenceBuilder, type EvidenceBuilderPort } from "@agent-anything/evidence";
import type { AuditPort, TelemetryPort } from "@agent-anything/observability";
import { InMemoryStorage, type StoragePort } from "@agent-anything/storage";
import { FakePermissionService, FakePolicyPort } from "@agent-anything/testing";
import {
  ToolRegistry,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
  type ToolRisk,
} from "@agent-anything/tools";
import { createRunCancellationController } from "../runner/RunCancellation.js";
import type { ToolActionBridgeInput } from "../runner/ToolActionBridge.js";
import { TemporaryToolActionBridge } from "./TemporaryToolActionBridge.js";
import { ToolExecutionBoundary } from "./ToolExecutionBoundary.js";

describe("TemporaryToolActionBridge", () => {
  it("maps an Action to ToolCall, stores Evidence, and returns immutable references", async () => {
    let receivedCall: ToolCall | null = null;
    const storage = new InMemoryStorage();
    const bridge = createBridge({
      storage,
      tool: createTool("safe", async (call) => {
        receivedCall = call;
        return toolResult(call, "succeeded", { answer: 42 });
      }),
    });

    const result = await bridge.execute(createInput({ toolRisk: "safe" }));

    expect(receivedCall).toMatchObject({
      id: "action_001",
      toolName: "test.read",
      input: { path: "README.md" },
      risk: "safe",
      metadata: { runId: "run_001", actionId: "action_001" },
    });
    expect(result).toMatchObject({
      status: "observed",
      outcome: "succeeded",
      observation: {
        kind: "tool_result",
        result: { toolCallId: "action_001", status: "succeeded" },
      },
      evidenceRefs: ["evidence_action_001"],
      artifactRefs: ["artifact_evidence_evidence_action_001"],
    });
    expect(Object.isFrozen(result.evidenceRefs)).toBe(true);
    expect(storage.getEvidence("evidence_action_001")).toBeDefined();
  });

  it("keeps skipped ToolResult out of model-visible Observations", async () => {
    const bridge = createBridge({
      tool: createTool("safe", async (call) => toolResult(call, "skipped", null)),
    });

    const result = await bridge.execute(createInput());

    expect(result).toMatchObject({
      status: "observed",
      outcome: "succeeded",
      observation: null,
      evidenceRefs: [],
      artifactRefs: [],
    });
  });

  it("maps policy blocks to ActionDeniedObservation payloads", async () => {
    const bridge = createBridge({
      tool: createTool("risky", async (call) => toolResult(call, "succeeded", "unused")),
      policyPort: new FakePolicyPort((input) => ({
        checkId: input.id,
        status: "denied",
        code: "policy_risk_denied",
        reason: "Risk is not allowed.",
        decidedAt: "2026-07-13T00:00:00.000Z",
      })),
    });

    const result = await bridge.execute(createInput({ toolRisk: "risky" }));

    expect(result).toMatchObject({
      status: "observed",
      outcome: "denied",
      observation: {
        kind: "action_denied",
        owner: "policy",
        code: "policy_risk_denied",
      },
    });
  });

  it("maps permission denial after policy allow to a permission-owned denial", async () => {
    const bridge = createBridge({
      tool: createTool("risky", async (call) => toolResult(call, "succeeded", "unused")),
      permissionService: new FakePermissionService((input) => ({
        requestId: input.id,
        status: "denied",
        code: "permission_denied",
        reason: "User declined the request.",
        decidedAt: "2026-07-13T00:00:00.000Z",
      })),
    });

    const result = await bridge.execute(createInput({ toolRisk: "risky" }));

    expect(result).toMatchObject({
      status: "observed",
      outcome: "denied",
      observation: {
        kind: "action_denied",
        owner: "permission",
        code: "permission_denied",
      },
    });
  });

  it("maps recoverable tool failures without terminating the Run", async () => {
    const bridge = createBridge({
      tool: createTool("safe", async (call) => ({
        ...toolResult(call, "timeout", null),
        error: { code: "tool_timeout", message: "Tool timed out." },
      })),
    });

    const result = await bridge.execute(createInput());

    expect(result).toMatchObject({
      status: "observed",
      outcome: "failed",
      observation: {
        kind: "action_failure",
        error: { owner: "tool", code: "tool_timeout" },
      },
    });
  });

  it.each([
    ["audit", "audit_required_failed"],
    ["telemetry", "runtime_telemetry_required_failed"],
  ] as const)("maps required %s recording failure to a terminal owner failure", async (
    owner,
    code,
  ) => {
    const throwingPort = { async record() { throw new Error(`${owner} unavailable`); } };
    const bridge = createBridge({
      tool: createTool("risky", async (call) => toolResult(call, "succeeded", "unused")),
      ...(owner === "audit"
        ? { auditPort: throwingPort as AuditPort }
        : { telemetryPort: throwingPort as TelemetryPort }),
    });

    const result = await bridge.execute(createInput({
      toolRisk: "risky",
      audit: "required",
      telemetry: "required",
    }));

    expect(result).toMatchObject({
      status: "terminal_failure",
      code,
      errors: [{ owner, code }],
    });
  });

  it("maps Evidence construction failure to a terminal tool owner failure", async () => {
    const bridge = createBridge({
      tool: createTool("safe", async (call) => toolResult(call, "succeeded", "output")),
      evidenceBuilder: {
        buildFromToolResult() {
          throw new Error("Evidence builder failed.");
        },
      },
    });

    const result = await bridge.execute(createInput());

    expect(result).toMatchObject({
      status: "terminal_failure",
      code: "tool_execution_failed",
      errors: [{ owner: "tool", code: "runtime_evidence_creation_failed" }],
    });
  });

  it("retains evidence and already-stored artifacts when storage fails", async () => {
    let stores = 0;
    const storage: StoragePort = {
      async storeEvidence(evidence) {
        stores += 1;
        if (stores === 2) {
          throw new Error("Storage unavailable.");
        }
        return {
          id: `artifact_${evidence.id}`,
          kind: "evidence",
          ref: `memory://${evidence.id}`,
          createdAt: "2026-07-13T00:00:00.000Z",
          metadata: {},
        };
      },
    };
    const evidenceBuilder: EvidenceBuilderPort = {
      buildFromToolResult({ toolResult: result }) {
        return ["one", "two"].map((suffix) => ({
          id: `evidence_${suffix}`,
          source: {
            kind: "toolResult" as const,
            toolCallId: result.toolCallId,
            toolName: result.toolName,
            metadata: {},
          },
          summary: suffix,
          content: suffix,
          sensitivity: "public" as const,
          metadata: {},
        }));
      },
    };
    const bridge = createBridge({
      storage,
      evidenceBuilder,
      tool: createTool("safe", async (call) => toolResult(call, "succeeded", "ok")),
    });

    const result = await bridge.execute(createInput());

    expect(result).toMatchObject({
      status: "terminal_failure",
      code: "storage_write_failed",
      errors: [{ owner: "storage" }],
      evidenceRefs: ["evidence_one", "evidence_two"],
      artifactRefs: ["artifact_evidence_one"],
    });
  });
});

function createBridge(options: {
  readonly tool: ToolDefinition;
  readonly storage?: StoragePort;
  readonly evidenceBuilder?: EvidenceBuilderPort;
  readonly policyPort?: ConstructorParameters<typeof ToolExecutionBoundary>[0]["policyPort"];
  readonly permissionService?: ConstructorParameters<typeof ToolExecutionBoundary>[0]["permissionService"];
  readonly auditPort?: AuditPort;
  readonly telemetryPort?: TelemetryPort;
}): TemporaryToolActionBridge {
  const registry = new ToolRegistry();
  registry.register(options.tool);
  const boundary = new ToolExecutionBoundary({
    toolRegistry: registry,
    evidenceBuilder: options.evidenceBuilder ?? new EvidenceBuilder(),
    policyPort: options.policyPort,
    permissionService: options.permissionService,
    auditPort: options.auditPort,
    telemetryPort: options.telemetryPort,
  });
  return new TemporaryToolActionBridge({
    boundary,
    storage: options.storage ?? new InMemoryStorage(),
    permissionMode: "trusted",
    metadata: {},
  });
}

function createInput(
  overrides: Partial<Pick<ToolActionBridgeInput, "toolRisk" | "audit" | "telemetry">> = {},
): ToolActionBridgeInput {
  return {
    action: {
      id: "action_001",
      runId: "run_001",
      sequence: 1,
      kind: "tool",
      name: "test.read",
      input: { path: "README.md" },
      provenance: { modelItemId: "model_001", controllerIteration: 1 },
    },
    task: {
      id: "task_001",
      kind: "test.runner",
      input: {},
      createdAt: "2026-07-13T00:00:00.000Z",
      metadata: {},
    },
    workspace: {
      id: "workspace_001",
      name: "Test workspace",
      rootRef: "workspace://root",
      trustState: "trusted",
      source: "test",
      policyRefs: [],
      metadata: {},
    },
    identity: {
      id: "user_001",
      kind: "user",
      displayName: "Test User",
      metadata: {},
    },
    cancellation: createRunCancellationController({ runId: "run_001" }).context,
    audit: "optional",
    telemetry: "optional",
    toolRisk: "safe",
    metadata: {},
    ...overrides,
  };
}

function createTool(
  risk: ToolRisk,
  execute: ToolDefinition["execute"],
): ToolDefinition {
  return { name: "test.read", risk, execute };
}

function toolResult(
  call: ToolCall,
  status: ToolResult["status"],
  output: unknown,
): ToolResult {
  return {
    toolCallId: call.id,
    toolName: call.toolName,
    status,
    output,
    error: null,
    startedAt: "2026-07-13T00:00:00.000Z",
    finishedAt: "2026-07-13T00:00:01.000Z",
    metadata: {},
  };
}

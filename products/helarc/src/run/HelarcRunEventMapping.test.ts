import type { RuntimeEvent, RuntimeEventName } from "@agent-anything/agent-core";
import type { Metadata } from "@agent-anything/shared";
import { describe, expect, it } from "vitest";
import { mapRuntimeEventToHelarcRunEvent } from "./HelarcRunEventMapping.js";

describe("mapRuntimeEventToHelarcRunEvent", () => {
  it("maps failed Controller turns without exposing provider payloads", () => {
    const event = mapRuntimeEventToHelarcRunEvent(runtimeEvent({
      name: "controller.finished",
      payload: {
        runId: "run-1",
        iteration: 1,
        status: "failed",
        code: "model_output_invalid",
        apiKey: "secret",
        rawProviderResponse: { choices: [] },
      },
    }));

    expect(event).toMatchObject({
      kind: "provider.output",
      title: "Controller failed",
      detail: "model_output_invalid",
      severity: "error",
      metadata: {
        runtimeEventName: "controller.finished",
        taskId: "task-1",
        runId: "run-1",
        iteration: 1,
        status: "failed",
        code: "model_output_invalid",
      },
    });
    expect(event.metadata).not.toHaveProperty("apiKey");
    expect(event.metadata).not.toHaveProperty("rawProviderResponse");
  });

  it("maps allowlisted call-tool Controller trace", () => {
    const event = mapRuntimeEventToHelarcRunEvent(runtimeEvent({
      name: "controller.finished",
      payload: {
        runId: "run-1",
        iteration: 2,
        status: "succeeded",
        decisionKind: "actions",
        controllerAction: "call_tool",
        promptArchitectureVersion: "helarc-prompt-v1",
        actionContractVersion: "helarc-action-v1",
        toolCatalogVersion: "helarc-tool-catalog-v1",
        exposedToolNames: ["codeAgent.readFile"],
        requestedToolName: "codeAgent.readFile",
        rawPrompt: "secret prompt",
      },
    }));

    expect(event).toMatchObject({
      kind: "provider.output",
      title: "Controller succeeded",
      detail: "codeAgent.readFile",
      metadata: {
        controllerAction: "call_tool",
        requestedToolName: "codeAgent.readFile",
        exposedToolNames: ["codeAgent.readFile"],
      },
    });
    expect(event.metadata).not.toHaveProperty("rawPrompt");
  });

  it("maps proposed patch trace without file content", () => {
    const event = mapRuntimeEventToHelarcRunEvent(runtimeEvent({
      name: "controller.finished",
      payload: {
        iteration: 1,
        status: "succeeded",
        controllerAction: "propose",
        patchOperation: "create",
        patchPath: "empty.txt",
        proposedContent: "secret content",
      },
    }));

    expect(event).toMatchObject({
      detail: "create empty.txt",
      metadata: {
        controllerAction: "propose",
        patchOperation: "create",
        patchPath: "empty.txt",
      },
    });
    expect(event.metadata).not.toHaveProperty("proposedContent");
  });

  it("maps tool execution by Runner-owned action id", () => {
    const event = mapRuntimeEventToHelarcRunEvent(runtimeEvent({
      name: "tool.finished",
      payload: {
        runId: "run-1",
        actionId: "action-1",
        toolName: "codeAgent.readFile",
        status: "succeeded",
        command: "cat secret.txt",
      },
    }));

    expect(event).toMatchObject({
      kind: "tool.completed",
      title: "Tool succeeded: codeAgent.readFile",
      detail: "action-1",
      metadata: {
        runId: "run-1",
        actionId: "action-1",
        toolName: "codeAgent.readFile",
        status: "succeeded",
      },
    });
    expect(event.metadata).not.toHaveProperty("command");
  });

  it("maps committed Run items without exposing item content", () => {
    const event = mapRuntimeEventToHelarcRunEvent(runtimeEvent({
      name: "run.item.appended",
      payload: {
        runId: "run-1",
        itemId: "item-2",
        itemKind: "observation",
        itemSequence: 2,
        observation: { raw: "private model-visible content" },
      },
    }));

    expect(event).toMatchObject({
      kind: "runtime.output",
      title: "Run item appended: observation",
      detail: "item-2",
      metadata: {
        runId: "run-1",
        itemId: "item-2",
        itemKind: "observation",
        itemSequence: 2,
      },
    });
    expect(event.metadata).not.toHaveProperty("observation");
  });

  it("maps terminal Run events", () => {
    const completed = mapRuntimeEventToHelarcRunEvent(runtimeEvent({
      name: "run.completed",
      payload: { runId: "run-1", status: "succeeded" },
    }));

    expect(completed).toMatchObject({
      kind: "run.completed",
      title: "Run completed",
      severity: "info",
    });
  });

  it("maps approval lifecycle summaries without internal request data", () => {
    const requested = mapRuntimeEventToHelarcRunEvent(runtimeEvent({
      name: "approval.requested",
      payload: {
        runId: "run-1",
        requestId: "approval-1",
        actionId: "action-1",
        pendingVersion: 2,
        category: "permissions",
        reviewer: "user",
        phase: "reviewing",
        reviewOperationId: "review-1",
        trustedProposals: [{ secret: true }],
      },
    }));
    const resolved = mapRuntimeEventToHelarcRunEvent(runtimeEvent({
      name: "approval.resolved",
      payload: {
        runId: "run-1",
        requestId: "approval-1",
        actionId: "action-1",
        pendingVersion: 2,
        reviewer: "user",
        resolutionKind: "decision",
        decisionKind: "grantPermissions",
        applicationKind: "applied",
        authorityRecordIds: ["grant-1"],
        internalRequest: { secret: true },
      },
    }));

    expect(requested).toMatchObject({
      kind: "approval.requested",
      title: "Approval requested: permissions",
      detail: "approval-1",
      metadata: { pendingVersion: 2, reviewer: "user", phase: "reviewing" },
    });
    expect(resolved).toMatchObject({
      kind: "approval.resolved",
      title: "Approval grantPermissions",
      detail: "approval-1",
      metadata: {
        resolutionKind: "decision",
        applicationKind: "applied",
        authorityRecordIds: ["grant-1"],
      },
    });
    expect(JSON.stringify([requested, resolved])).not.toContain("secret");
  });

  it("maps Retry progress from the closed Host projection", () => {
    const event = mapRuntimeEventToHelarcRunEvent(runtimeEvent({
      name: "retry.scheduled",
      payload: {
        type: "retry_scheduled",
        runId: "run-1",
        operationId: "provider-operation-1",
        owner: "provider_request",
        occurredAt: "2026-07-04T00:00:00.000Z",
        afterAttemptId: "attempt-1",
        budgetId: "budget-1",
        retryNumber: 1,
        nextAttemptNumber: 2,
        nextBudgetAttemptNumber: 2,
        delayMs: 250,
        delaySource: "policy",
        nextAttemptAt: "2026-07-04T00:00:00.250Z",
        failureCategory: "transport",
        failureCode: "provider_transport_failed",
        rawProviderResponse: "secret response",
        apiKey: "secret key",
      },
    }));

    expect(event).toMatchObject({
      kind: "retry.progress",
      title: "Retry 2 scheduled",
      detail: "provider-operation-1",
      severity: "info",
      metadata: {
        runtimeEventName: "retry.scheduled",
        taskId: "task-1",
        type: "retry_scheduled",
        runId: "run-1",
        operationId: "provider-operation-1",
        owner: "provider_request",
        retryNumber: 1,
        nextAttemptNumber: 2,
        delayMs: 250,
        delaySource: "policy",
        failureCategory: "transport",
        failureCode: "provider_transport_failed",
      },
    });
    expect(JSON.stringify(event)).not.toContain("secret");
    expect(event.metadata).not.toHaveProperty("rawProviderResponse");
    expect(event.metadata).not.toHaveProperty("apiKey");
  });

  it("labels disabled enforcement as unisolated and excludes provider internals", () => {
    const started = mapRuntimeEventToHelarcRunEvent(runtimeEvent({
      name: "sandbox.attempt.started",
      payload: {
        actionId: "action-1",
        attemptId: "attempt-1",
        ordinal: 1,
        enforcement: "disabled",
        policyId: "private-policy",
      },
    }));
    const resolved = mapRuntimeEventToHelarcRunEvent(runtimeEvent({
      name: "sandbox.attempt.resolved",
      payload: {
        actionId: "action-1",
        attemptId: "attempt-1",
        ordinal: 1,
        enforcement: "disabled",
        outcome: "executed",
        code: "succeeded",
        enforcementEvidence: { private: true },
      },
    }));

    expect(started).toMatchObject({
      kind: "sandbox.started",
      title: "Unisolated execution started",
      severity: "warning",
      metadata: { enforcement: "disabled", ordinal: 1 },
    });
    expect(resolved).toMatchObject({
      kind: "sandbox.resolved",
      title: "Unisolated execution completed",
      metadata: { enforcement: "disabled", outcome: "executed" },
    });
    expect(JSON.stringify([started, resolved])).not.toContain("private-policy");
    expect(resolved.metadata).not.toHaveProperty("enforcementEvidence");
  });
});

function runtimeEvent(input: {
  name: RuntimeEventName;
  payload: Metadata;
}): RuntimeEvent {
  return {
    id: "event-1",
    name: input.name,
    taskId: "task-1",
    sequence: 1,
    timestamp: "2026-07-04T00:00:00.000Z",
    payload: input.payload,
  };
}

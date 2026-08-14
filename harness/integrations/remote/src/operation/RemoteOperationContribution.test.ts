import type { PreparedAction } from "@agent-anything/action-execution/registration";
import type { CanonicalActionSettlement } from "@agent-anything/canonical-action/settlement";
import { describe, expect, it } from "vitest";
import type { TrustedRemoteOperationRegistration } from "./RemoteOperationContribution.js";
import { createRemoteOperationContribution } from "./createRemoteOperationContribution.js";

const NOW = "2026-08-14T01:00:00.000Z";

describe("createRemoteOperationContribution", () => {
  it("registers an optional Tool against one hosted Operation and one canonical Action route", () => {
    const contribution = createRemoteOperationContribution({
      registration: registration(),
      transport: { async invoke() { throw new Error("not executed"); } },
    });

    expect(contribution.operations).toHaveLength(1);
    expect(contribution.bindings).toHaveLength(1);
    expect(contribution.tools).toHaveLength(1);
    expect(contribution.actionRegistrations.registrations[0]).toMatchObject({
      operation: registration().operation,
      binding: registration().binding,
      effectFamilies: ["network", "remote_invocation"],
    });
  });

  it("keeps physical completion distinct from remote semantic failure", async () => {
    const expected = registration();
    const contribution = createRemoteOperationContribution({
      registration: expected,
      now: () => NOW,
      transport: {
        async invoke() {
          return {
            status: "completed" as const,
            output: { content: [] },
            semanticError: {
              code: "remote_reported_error",
              message: "Remote implementation rejected the request.",
              metadata: {},
            },
            metadata: { protocol: "test" },
          };
        },
      },
    });
    const settlement: CanonicalActionSettlement = {
      ref: { action: { id: "action-1" }, id: "settlement-1" },
      action: { id: "action-1" },
      subject: { action: { id: "action-1" }, revision: 1 },
      operationInvocation: { id: "operation-invocation-1", operation: expected.operation },
      binding: expected.binding,
      status: "succeeded",
      attempts: [{ action: { id: "action-1" }, id: "attempt-1", ordinal: 1 }],
      effectCertainty: "confirmed",
      completionExtent: "complete",
      payload: {
        output: { content: [] },
        semanticError: {
          code: "remote_reported_error",
          message: "Remote implementation rejected the request.",
          metadata: {},
        },
        metadata: { protocol: "test" },
        startedAt: NOW,
        finishedAt: NOW,
      },
      causeOwner: null,
      causeRef: null,
      reconciliationRequired: false,
      settledAt: NOW,
    };
    const semantic = await contribution.adapters[0]!.adapter.settle(
      {} as PreparedAction,
      settlement,
    );
    expect(semantic.status).toBe("failed");
    expect(semantic.settlement.status).toBe("succeeded");
    expect(semantic.failure).toMatchObject({
      owner: "remote.status",
      code: "remote_reported_error",
    });
  });

  it("rejects hosted registrations without an endpoint reference", () => {
    expect(() => createRemoteOperationContribution({
      registration: registration({ hostedEndpointRef: null }),
      transport: { async invoke() { throw new Error("not executed"); } },
    })).toThrow("requires a hosted endpoint reference");
  });
});

function registration(
  overrides: Partial<TrustedRemoteOperationRegistration> = {},
): TrustedRemoteOperationRegistration {
  const operation = Object.freeze({
    operation: Object.freeze({ namespace: "remote.example", name: "status" }),
    revision: "1",
  });
  return {
    operation,
    binding: { operation, revision: "1" },
    bindingKind: "hosted",
    hostedEndpointRef: "remote:example",
    semanticOwner: "remote.status",
    allowedRequestOrigins: ["tool_request"],
    source: {
      kind: "remote",
      sourceId: "remote-example",
      sourceRevision: "1",
      activationEpoch: 1,
      capabilityId: "status",
    },
    sourceDisplayName: "Remote Example",
    server: {
      serverId: "remote-example",
      registrationFingerprint: "remote-registration-1",
      transport: "https",
      endpoint: {
        transport: "tcp",
        host: "example.test",
        port: 443,
        applicationProtocol: "https",
      },
    },
    serverDisplayName: "Remote Example",
    remoteOperationName: "status",
    remoteOperationDisplayName: "Status",
    localTool: {
      ref: { tool: { namespace: "remote.example", name: "status" }, revision: "1" },
      name: "remote.status",
      inputSchema: { type: "object" },
      schemaRevisions: {
        dialect: "json-schema-2020-12",
        input: "1",
        output: "1",
        translation: "native-1",
      },
      allowedOrigins: ["model"],
    },
    registrationRevision: "1",
    admittedAt: NOW,
    supportsSessionAuthority: false,
    timeoutMs: 1_000,
    ...overrides,
  };
}

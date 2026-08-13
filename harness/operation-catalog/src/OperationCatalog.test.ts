import { describe, expect, it } from "vitest";
import { createOperationCatalogSnapshot } from "./catalog/index.js";
import {
  snapshotResolvedOperationBinding,
  unavailableOperationBindingResolver,
} from "./binding/index.js";
import {
  snapshotOperationCorrelation,
  snapshotOperationInvocationRef,
} from "./identity/index.js";

const revision = { operation: { namespace: "code", name: "read" }, revision: "v1" };

function entry() {
  return {
    admissionId: "admission-1",
    operation: {
      ref: revision,
      semanticOwner: "code-workspace",
      requestSchemaRevision: "v1",
      resultSchemaRevision: "v1",
      roles: {
        requestOrigins: ["tool_request" as const],
        exposure: "eager_tool" as const,
        runControl: "direct" as const,
        trust: "canonical_external_effect" as const,
        participation: "semantic_owner" as const,
        domainPurpose: "code.read",
      },
    },
    binding: {
      ref: { operation: revision, revision: "binding-v1" },
      kind: "direct" as const,
      resolverId: "resolver.read",
      resolverRevision: "v1",
    },
    sourceRevision: "source-v1",
    allowedRequestOrigins: ["tool_request" as const],
    admittedAt: "2026-08-12T00:00:00.000Z",
    retirement: null,
  };
}

describe("Operation Catalog contracts", () => {
  it("creates canonical immutable snapshots", () => {
    const snapshot = createOperationCatalogSnapshot({ id: "catalog-1", revision: "v1", entries: [entry()] });
    expect(Object.isFrozen(snapshot.entries)).toBe(true);
    expect(Object.isFrozen(snapshot.entries[0]?.operation.roles.requestOrigins)).toBe(true);
  });

  it("rejects duplicate revisions and unsupported fields", () => {
    expect(() => createOperationCatalogSnapshot({ id: "catalog-1", revision: "v1", entries: [entry(), entry()] }))
      .toThrow(/Duplicate identity/);
    expect(() => createOperationCatalogSnapshot({ id: "catalog-1", revision: "v1", entries: [], extra: true } as never))
      .toThrow(/Unsupported field/);
  });

  it("reports missing resolver implementation as typed unavailability", () => {
    expect(unavailableOperationBindingResolver("resolver.read")).toEqual({
      status: "unavailable",
      code: "resolver_unavailable",
      resolverId: "resolver.read",
    });
  });

  it("snapshots all four exact correlation forms", () => {
    const runAction = {
      run: { id: "run-1" },
      id: "action-1",
      sequence: 1,
    } as const;
    const correlations = [
      {
        kind: "run_action",
        run: { id: "run-1" },
        runAction,
        provenance: {
          kind: "controller",
          turn: { run: { id: "run-1" }, id: "turn-1", sequence: 1 },
          candidateIndex: 0,
        },
        materializationRevision: 4,
      },
      {
        kind: "run_request",
        run: { id: "run-1" },
        requestId: "projection-1",
        runBasisRevision: 4,
        purpose: "context.projection",
      },
      {
        kind: "owner_operation",
        owner: "product.helarc",
        operationId: "maintenance-1",
        operationRevision: "v1",
      },
      {
        kind: "evaluation_trial",
        campaignId: "campaign-1",
        trialId: "trial-1",
        targetSnapshotId: "target-1",
        isolatedOperationId: "operation-1",
      },
    ] as const;

    for (const correlation of correlations) {
      const snapshot = snapshotOperationCorrelation(correlation);
      expect(Object.isFrozen(snapshot)).toBe(true);
    }
  });

  it("rejects inconsistent or underspecified correlation identity", () => {
    expect(() => snapshotOperationCorrelation({
      kind: "run_action",
      run: { id: "run-1" },
      runAction: { run: { id: "run-2" }, id: "action-1", sequence: 1 },
      provenance: {
        kind: "automatic",
        trigger: { owner: "runtime", operationId: "operation-1" },
      },
      materializationRevision: 1,
    })).toThrow(/same Run/);
    expect(() => snapshotOperationCorrelation({
      kind: "run_request",
      run: { id: "run-1" },
      requestId: "request-1",
      runBasisRevision: 1,
      purpose: "context.projection",
      extra: true,
    } as never)).toThrow(/Unsupported field/);
  });

  it("captures the exact binding revision, request, and routing form", () => {
    const invocation = snapshotOperationInvocationRef({ id: "invocation-1", operation: revision });
    const request = { path: "src/index.ts" };
    const snapshot = snapshotResolvedOperationBinding({
      kind: "direct",
      invocation,
      correlation: {
        kind: "owner_operation",
        owner: "code-workspace",
        operationId: "read-1",
        operationRevision: "v1",
      },
      parentInvocation: null,
      binding: { operation: revision, revision: "binding-v1" },
      request,
      resolverRevision: "resolver-v1",
      resolutionFingerprint: "sha256:abc123",
      actionAdapterId: "action.code.read",
    }, (value) => Object.freeze({ path: value.path }));

    request.path = "changed.ts";
    expect(snapshot.request.path).toBe("src/index.ts");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot.binding.revision).toBe("binding-v1");
  });

  it("rejects a resolved binding for another Operation revision", () => {
    expect(() => snapshotResolvedOperationBinding({
      kind: "internal",
      invocation: { id: "invocation-1", operation: revision },
      correlation: {
        kind: "owner_operation",
        owner: "code-workspace",
        operationId: "read-1",
        operationRevision: "v1",
      },
      parentInvocation: null,
      binding: {
        operation: {
          operation: { namespace: "code", name: "search" },
          revision: "v1",
        },
        revision: "binding-v1",
      },
      request: Object.freeze({}),
      resolverRevision: "resolver-v1",
      resolutionFingerprint: "sha256:abc123",
      handlerId: "handler.read",
    }, (value) => value)).toThrow(/does not match/);
  });
});

import {
  createOperationBindingResolverSnapshot,
  snapshotResolvedOperationBinding,
  type OperationBindingKind,
  type OperationBindingResolutionInput,
  type ResolvedOperationBinding,
} from "@agent-anything/operation-catalog/binding";
import {
  createOperationCatalogSnapshot,
  type RegisteredOperation,
} from "@agent-anything/operation-catalog/catalog";
import type {
  OperationInvocationContext,
  OperationRevisionRef,
} from "@agent-anything/operation-catalog/identity";
import { describe, expect, it } from "vitest";
import { PHASE27_BINDING_CONFORMANCE } from "./Phase27CatalogRealization.js";

const NOW = "2026-08-14T00:00:00.000Z";
const KINDS: readonly OperationBindingKind[] = [
  "internal",
  "direct",
  "hosted",
  "composite",
  "descendant_agent",
];

describe("Phase27 Operation binding conformance", () => {
  it("resolves every binding form with exact identity, revision, and fingerprint", async () => {
    const entries = KINDS.map(registration);
    const catalog = createOperationCatalogSnapshot({
      id: "phase27.binding-conformance",
      revision: "1",
      entries,
    });
    const resolvers = createOperationBindingResolverSnapshot(
      "phase27.binding-resolvers.v1",
      KINDS.map((kind) => ({
        resolver: {
          id: `phase27.${kind}.resolver`,
          revision: "1",
          async resolve(input: OperationBindingResolutionInput<unknown, unknown>) {
            return {
              status: "resolved" as const,
              binding: snapshotResolvedOperationBinding(
                resolved(kind, input),
                (request) => Object.freeze(structuredClone(request)),
              ),
            };
          },
        },
      })),
    );

    for (const entry of catalog.entries) {
      const context = invocationContext(entry.operation.ref);
      const resolution = await resolvers.resolve({
        operation: entry,
        context,
        request: { kind: entry.binding.kind },
        basis: { revision: 1 },
      });
      expect(resolution.status).toBe("resolved");
      if (resolution.status !== "resolved") continue;
      expect(resolution.binding).toMatchObject({
        kind: entry.binding.kind,
        invocation: context.invocation,
        correlation: context.correlation,
        parentInvocation: null,
        binding: entry.binding.ref,
        resolverRevision: "1",
        resolutionFingerprint: `phase27:${entry.binding.kind}:fingerprint`,
      });
      expect(Object.isFrozen(resolution.binding)).toBe(true);
    }
  });

  it("preserves the accepted parent Action and child cardinality invariants", () => {
    expect(PHASE27_BINDING_CONFORMANCE).toEqual([
      expect.objectContaining({ bindingFamily: "internal", parentActionCount: 1, childActionCardinality: "none", childRunCardinality: "none" }),
      expect.objectContaining({ bindingFamily: "direct", parentActionCount: 1, childActionCardinality: "none", childRunCardinality: "none" }),
      expect.objectContaining({ bindingFamily: "hosted", parentActionCount: 1, childActionCardinality: "none", childRunCardinality: "none" }),
      expect.objectContaining({ bindingFamily: "composite", parentActionCount: 0, childActionCardinality: "bounded", childRunCardinality: "none" }),
      expect.objectContaining({ bindingFamily: "descendant_agent", parentActionCount: 0, childActionCardinality: "none", childRunCardinality: "one" }),
    ]);
  });

  it("reports a missing trusted resolver as typed unavailability", async () => {
    const entry = registration("hosted");
    const resolvers = createOperationBindingResolverSnapshot("empty.v1", []);
    const resolution = await resolvers.resolve({
      operation: entry,
      context: invocationContext(entry.operation.ref),
      request: {},
      basis: {},
    });

    expect(resolution).toEqual({
      status: "unavailable",
      code: "resolver_unavailable",
      resolverId: "phase27.hosted.resolver",
    });
  });
});

function registration(kind: OperationBindingKind): RegisteredOperation {
  const operation = operationRef(kind);
  return {
    admissionId: `phase27.${kind}.admission`,
    operation: {
      ref: operation,
      semanticOwner: `phase27.${kind}.owner`,
      requestSchemaRevision: "1",
      resultSchemaRevision: "1",
      roles: {
        requestOrigins: ["controller_protocol"],
        exposure: "non_tool",
        runControl: kind,
        trust: kind === "direct"
          ? "canonical_external_effect"
          : kind === "hosted"
            ? "remote_hosted_trust_edge"
            : "effect_free",
        participation: kind === "composite"
          ? "composite_coordinator"
          : kind === "descendant_agent"
            ? "descendant_adapter"
            : "semantic_owner",
        domainPurpose: `phase27.${kind}.conformance`,
      },
    },
    binding: {
      ref: { operation, revision: "binding-1" },
      kind,
      resolverId: `phase27.${kind}.resolver`,
      resolverRevision: "1",
    },
    sourceRevision: "1",
    allowedRequestOrigins: ["controller_protocol"],
    admittedAt: NOW,
    retirement: null,
  };
}

function resolved(
  kind: OperationBindingKind,
  input: OperationBindingResolutionInput<unknown, unknown>,
): ResolvedOperationBinding {
  const base = {
    invocation: input.context.invocation,
    correlation: input.context.correlation,
    parentInvocation: input.context.parentInvocation,
    binding: input.registration.binding.ref,
    request: input.request,
    resolverRevision: "1",
    resolutionFingerprint: `phase27:${kind}:fingerprint`,
  };
  switch (kind) {
    case "internal":
      return { ...base, kind, handlerId: "phase27.internal.handler" };
    case "direct":
      return { ...base, kind, actionAdapterId: "phase27.direct.adapter" };
    case "hosted":
      return {
        ...base,
        kind,
        actionAdapterId: "phase27.hosted.adapter",
        hostedEndpointRef: "phase27.hosted.endpoint",
      };
    case "composite":
      return { ...base, kind, compositeDefinitionRef: "phase27.composite.v1" };
    case "descendant_agent":
      return { ...base, kind, agentRef: { id: "phase27.agent", revision: "1" } };
  }
}

function operationRef(kind: OperationBindingKind): OperationRevisionRef {
  return {
    operation: { namespace: "phase27.conformance", name: kind },
    revision: "1",
  };
}

function invocationContext(operation: OperationRevisionRef): OperationInvocationContext {
  return {
    invocation: { id: `invocation-${operation.operation.name}`, operation },
    correlation: {
      kind: "owner_operation",
      owner: "phase27.conformance",
      operationId: `operation-${operation.operation.name}`,
      operationRevision: "1",
    },
    parentInvocation: null,
    interruption: { signal: new AbortController().signal, interruption: null },
  };
}

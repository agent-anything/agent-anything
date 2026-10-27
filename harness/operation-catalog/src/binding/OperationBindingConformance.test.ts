import {
  createOperationBindingResolverSnapshot,
  invalidOperationBinding,
  snapshotResolvedOperationBinding,
  type OperationBindingKind,
  type OperationBindingResolutionInput,
  type ResolvedOperationBinding,
} from "./index.js";
import {
  createOperationDefinitionCatalog,
  type RegisteredOperationDefinition,
} from "../catalog/index.js";
import type {
  OperationInvocationContext,
  OperationDefinitionRevisionRef,
} from "../identity/index.js";
import { describe, expect, it } from "vitest";

const NOW = "2026-08-14T00:00:00.000Z";
const KINDS: readonly OperationBindingKind[] = [
  "internal",
  "direct",
  "hosted",
  "composite",
  "descendant_agent",
];

describe("Operation binding conformance", () => {
  it("retains compensation intent separately from domain input and binds it to this caller", () => {
    const entry = registration("direct"), prior = invocationContext(entry.operation.ref);
    const correlation = {kind: "run_action" as const, run: {id: "run-1"}, runAction: {id: "action-1", run: {id: "run-1"}, sequence: 1},
      provenance: {kind: "controller" as const, turn: {id: "turn-1", run: {id: "run-1"}, sequence: 1}, candidateIndex: 0}, materializationRevision: 3};
    const context = {...prior, correlation};
    const original = resolved("direct", {registration: entry, context, request: {path: "file.txt"}, basis: {}});
    const target = {owner: "files", kind: "execution" as const, id: "earlier-execution", revision: "1"};
    const compensation = {id: "intent-1", invocation: context.invocation, correlation, call: {id: "call-1", turnId: "turn-1"},
      targets: [{requested: target, execution: target, result: {id: "result-0", invocation: {...context.invocation, id: "invocation-0"}},
        resultRevision: "1", sourceCorrelation: prior.correlation}], explanation: "The objective changed.", acceptedAt: NOW};
    const saved = snapshotResolvedOperationBinding({...original, compensation}, structuredClone);
    expect(saved.compensation).toEqual(compensation);
    expect(saved.request).toEqual({path: "file.txt"});
    expect(snapshotResolvedOperationBinding(JSON.parse(JSON.stringify(saved)), structuredClone)).toEqual(saved);
    expect(() => snapshotResolvedOperationBinding({...original, compensation: {...compensation, invocation: {...compensation.invocation, id: "other"}}}, structuredClone)).toThrow("this invocation");
    expect(() => snapshotResolvedOperationBinding({...original, compensation: {...compensation, correlation: {...correlation, materializationRevision: 4}}}, structuredClone)).toThrow("this invocation");
    expect(snapshotResolvedOperationBinding(original, structuredClone)).not.toHaveProperty("compensation");
  });

  it("distinguishes correctable input rejection from missing infrastructure", async () => {
    const entry = registration("direct");
    const rejection = invalidOperationBinding("files", "execution_reference_unavailable", "Use a reference disclosed to this Run.");
    const resolvers = createOperationBindingResolverSnapshot("test", [{resolver: {id: entry.binding.resolverId,
      revision: entry.binding.resolverRevision, async resolve() {return rejection;}}}]);
    expect(await resolvers.resolve({operation: entry, context: invocationContext(entry.operation.ref), request: {}, basis: {}})).toEqual(rejection);
  });

  it("resolves every binding form with exact identity, revision, and fingerprint", async () => {
    const entries = KINDS.map(registration);
    const catalog = createOperationDefinitionCatalog({
      id: "operation.binding-conformance",
      revision: "1",
      entries,
    });
    const resolvers = createOperationBindingResolverSnapshot(
      "operation.binding-resolvers.v1",
      KINDS.map((kind) => ({
        resolver: {
          id: `operation.${kind}.resolver`,
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
        resolutionFingerprint: `operation:${entry.binding.kind}:fingerprint`,
      });
      expect(Object.isFrozen(resolution.binding)).toBe(true);
    }
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
      resolverId: "operation.hosted.resolver",
    });
  });
});

function registration(kind: OperationBindingKind): RegisteredOperationDefinition {
  const operation = operationRef(kind);
  return {
    admissionId: `operation.${kind}.admission`,
    operation: {
      ref: operation,
      semanticOwner: `operation.${kind}.owner`,
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
        domainPurpose: `operation.${kind}.conformance`,
      },
    },
    binding: {
      ref: { operation, revision: "binding-1" },
      kind,
      resolverId: `operation.${kind}.resolver`,
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
    resolutionFingerprint: `operation:${kind}:fingerprint`,
  };
  switch (kind) {
    case "internal":
      return { ...base, kind, handlerId: "operation.internal.handler" };
    case "direct":
      return { ...base, kind, actionAdapterId: "operation.direct.adapter" };
    case "hosted":
      return {
        ...base,
        kind,
        actionAdapterId: "operation.hosted.adapter",
        hostedEndpointRef: "operation.hosted.endpoint",
      };
    case "composite":
      return { ...base, kind, compositeDefinitionRef: "operation.composite.v1" };
    case "descendant_agent":
      return { ...base, kind, agentRef: { id: "operation.agent", revision: "1" } };
  }
}

function operationRef(kind: OperationBindingKind): OperationDefinitionRevisionRef {
  return {
    operation: { namespace: "operation.conformance", name: kind },
    revision: "1",
  };
}

function invocationContext(operation: OperationDefinitionRevisionRef): OperationInvocationContext {
  return {
    invocation: { id: `invocation-${operation.operation.name}`, operation },
    correlation: {
      kind: "owner_operation",
      owner: "operation.conformance",
      operationId: `operation-${operation.operation.name}`,
      operationRevision: "1",
    },
    parentInvocation: null,
    interruption: { signal: new AbortController().signal, interruption: null },
  };
}

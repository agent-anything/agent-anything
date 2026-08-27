import type { RegisteredOperation } from "../catalog/index.js";
import type { AgentRevisionRef } from "@agent-anything/agent-core/agent";
import type {
  OperationBindingRevisionRef,
  OperationCorrelation,
  OperationInvocationContext,
  OperationInvocationRef,
} from "../identity/index.js";
import {
  operationRevisionKey,
  snapshotOperationBindingRevisionRef,
  snapshotOperationCorrelation,
  snapshotOperationInvocationRef,
} from "../identity/index.js";
import { fail, strictRecord, token } from "../contract/OperationContractValidation.js";

export type OperationBindingKind =
  | "internal"
  | "direct"
  | "hosted"
  | "composite"
  | "descendant_agent";

interface ResolvedOperationBindingBase<TRequest> {
  readonly invocation: OperationInvocationRef;
  readonly correlation: OperationCorrelation;
  readonly parentInvocation: OperationInvocationRef | null;
  readonly binding: OperationBindingRevisionRef;
  readonly request: TRequest;
  readonly resolverRevision: string;
  readonly resolutionFingerprint: string;
}

export interface InternalOperationBinding<TRequest = unknown>
  extends ResolvedOperationBindingBase<TRequest> {
  readonly kind: "internal";
  readonly handlerId: string;
}

export interface DirectOperationBinding<TRequest = unknown>
  extends ResolvedOperationBindingBase<TRequest> {
  readonly kind: "direct";
  readonly actionAdapterId: string;
}

export interface HostedOperationBinding<TRequest = unknown>
  extends ResolvedOperationBindingBase<TRequest> {
  readonly kind: "hosted";
  readonly actionAdapterId: string;
  readonly hostedEndpointRef: string;
}

export interface CompositeOperationBinding<TRequest = unknown>
  extends ResolvedOperationBindingBase<TRequest> {
  readonly kind: "composite";
  readonly compositeDefinitionRef: string;
}

export interface DescendantAgentOperationBinding<TRequest = unknown>
  extends ResolvedOperationBindingBase<TRequest> {
  readonly kind: "descendant_agent";
  readonly agentRef: AgentRevisionRef;
}

export type ResolvedOperationBinding<TRequest = unknown> =
  | InternalOperationBinding<TRequest>
  | DirectOperationBinding<TRequest>
  | HostedOperationBinding<TRequest>
  | CompositeOperationBinding<TRequest>
  | DescendantAgentOperationBinding<TRequest>;

export interface OperationBindingResolutionInput<TRequest, TBasis> {
  readonly registration: RegisteredOperation;
  readonly context: OperationInvocationContext;
  readonly request: TRequest;
  readonly basis: TBasis;
}

export type OperationBindingResolution<TRequest = unknown> =
  | { readonly status: "resolved"; readonly binding: ResolvedOperationBinding<TRequest> }
  | {
      readonly status: "unavailable";
      readonly code: "resolver_unavailable";
      readonly resolverId: string;
    };

export interface OperationBindingResolverPort<TRequest = unknown, TBasis = unknown> {
  readonly id: string;
  readonly revision: string;
  resolve(
    input: OperationBindingResolutionInput<TRequest, TBasis>,
  ): Promise<OperationBindingResolution<TRequest>>;
}

export function snapshotResolvedOperationBinding<TRequest>(
  input: ResolvedOperationBinding<TRequest>,
  snapshotRequest: (request: TRequest) => TRequest,
): ResolvedOperationBinding<TRequest> {
  strictRecord(input, "ResolvedOperationBinding", [
    "kind",
    "invocation",
    "correlation",
    "parentInvocation",
    "binding",
    "request",
    "resolverRevision",
    "resolutionFingerprint",
    "handlerId",
    "actionAdapterId",
    "hostedEndpointRef",
    "compositeDefinitionRef",
    "agentRef",
  ], "operation_binding_invalid");
  const base = snapshotResolvedBindingBase(input, snapshotRequest);

  switch (input.kind) {
    case "internal":
      strictRecord(input, "ResolvedOperationBinding", [
        ...resolvedBindingBaseFields,
        "kind",
        "handlerId",
      ], "operation_binding_invalid");
      return Object.freeze({
        ...base,
        kind: "internal",
        handlerId: token(input.handlerId, "ResolvedOperationBinding.handlerId"),
      });
    case "direct":
      strictRecord(input, "ResolvedOperationBinding", [
        ...resolvedBindingBaseFields,
        "kind",
        "actionAdapterId",
      ], "operation_binding_invalid");
      return Object.freeze({
        ...base,
        kind: "direct",
        actionAdapterId: token(
          input.actionAdapterId,
          "ResolvedOperationBinding.actionAdapterId",
        ),
      });
    case "hosted":
      strictRecord(input, "ResolvedOperationBinding", [
        ...resolvedBindingBaseFields,
        "kind",
        "actionAdapterId",
        "hostedEndpointRef",
      ], "operation_binding_invalid");
      return Object.freeze({
        ...base,
        kind: "hosted",
        actionAdapterId: token(
          input.actionAdapterId,
          "ResolvedOperationBinding.actionAdapterId",
        ),
        hostedEndpointRef: token(
          input.hostedEndpointRef,
          "ResolvedOperationBinding.hostedEndpointRef",
        ),
      });
    case "composite":
      strictRecord(input, "ResolvedOperationBinding", [
        ...resolvedBindingBaseFields,
        "kind",
        "compositeDefinitionRef",
      ], "operation_binding_invalid");
      return Object.freeze({
        ...base,
        kind: "composite",
        compositeDefinitionRef: token(
          input.compositeDefinitionRef,
          "ResolvedOperationBinding.compositeDefinitionRef",
        ),
      });
    case "descendant_agent":
      strictRecord(input, "ResolvedOperationBinding", [
        ...resolvedBindingBaseFields,
        "kind",
        "agentRef",
      ], "operation_binding_invalid");
      return Object.freeze({
        ...base,
        kind: "descendant_agent",
        agentRef: snapshotAgentRevisionRef(
          input.agentRef,
          "ResolvedOperationBinding.agentRef",
        ),
      });
    default:
      return fail(
        "operation_binding_invalid",
        "Unsupported resolved Operation binding kind.",
        "ResolvedOperationBinding.kind",
      );
  }
}

function snapshotAgentRevisionRef(
  input: AgentRevisionRef,
  path: string,
): AgentRevisionRef {
  strictRecord(input, path, ["id", "revision"], "operation_binding_invalid");
  return Object.freeze({
    id: token(input.id, `${path}.id`),
    revision: token(input.revision, `${path}.revision`),
  });
}

export function unavailableOperationBindingResolver(
  resolverId: string,
): OperationBindingResolution {
  return Object.freeze({
    status: "unavailable",
    code: "resolver_unavailable",
    resolverId: token(resolverId, "OperationBindingResolution.resolverId"),
  });
}

const resolvedBindingBaseFields = [
  "invocation",
  "correlation",
  "parentInvocation",
  "binding",
  "request",
  "resolverRevision",
  "resolutionFingerprint",
] as const;

function snapshotResolvedBindingBase<TRequest>(
  input: ResolvedOperationBinding<TRequest>,
  snapshotRequest: (request: TRequest) => TRequest,
): ResolvedOperationBindingBase<TRequest> {
  const invocation = snapshotOperationInvocationRef(input.invocation);
  const binding = snapshotOperationBindingRevisionRef(input.binding);
  if (
    operationRevisionKey(invocation.operation) !==
    operationRevisionKey(binding.operation)
  ) {
    fail(
      "operation_binding_invalid",
      "Resolved binding revision does not match the Operation invocation.",
      "ResolvedOperationBinding.binding.operation",
    );
  }
  return Object.freeze({
    invocation,
    correlation: snapshotOperationCorrelation(input.correlation),
    parentInvocation:
      input.parentInvocation === null
        ? null
        : snapshotOperationInvocationRef(input.parentInvocation),
    binding,
    request: snapshotRequest(input.request),
    resolverRevision: token(
      input.resolverRevision,
      "ResolvedOperationBinding.resolverRevision",
    ),
    resolutionFingerprint: token(
      input.resolutionFingerprint,
      "ResolvedOperationBinding.resolutionFingerprint",
    ),
  });
}

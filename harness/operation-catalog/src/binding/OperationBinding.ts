import type { RegisteredOperationDefinition } from "../catalog/index.js";
import type { AgentDefinitionRevisionRef } from "@agent-anything/agent-core/agent";
import type {
  OperationBindingRevisionRef,
  OperationCorrelation,
  OperationInvocationContext,
  OperationInvocationRef,
} from "../identity/index.js";
import {
  operationDefinitionRevisionKey,
  snapshotOperationBindingRevisionRef,
  snapshotOperationCorrelation,
  snapshotOperationInvocationRef,
} from "../identity/index.js";
import { fail, strictRecord, token } from "../contract/OperationContractValidation.js";
import { snapshotCompensationAssociation, type CompensationAssociation } from "../evidence/CompensationAssociation.js";

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
  readonly compensation?: CompensationAssociation;
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
  readonly agentRef: AgentDefinitionRevisionRef;
}

export type ResolvedOperationBinding<TRequest = unknown> =
  | InternalOperationBinding<TRequest>
  | DirectOperationBinding<TRequest>
  | HostedOperationBinding<TRequest>
  | CompositeOperationBinding<TRequest>
  | DescendantAgentOperationBinding<TRequest>;

export interface OperationBindingResolutionInput<TRequest, TBasis> {
  readonly registration: RegisteredOperationDefinition;
  readonly context: OperationInvocationContext;
  readonly request: TRequest;
  readonly basis: TBasis;
}

export type OperationBindingResolution<TRequest = unknown> =
  | { readonly status: "resolved"; readonly binding: ResolvedOperationBinding<TRequest> }
  | { readonly status: "invalid"; readonly owner: string; readonly code: string; readonly message: string }
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
    "compensation",
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
  input: AgentDefinitionRevisionRef,
  path: string,
): AgentDefinitionRevisionRef {
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

export function invalidOperationBinding(owner: string, code: string, message: string): OperationBindingResolution<never> {
  if (typeof message !== "string" || !message || message.length > 8192) throw new TypeError("Invalid binding rejection message.");
  return Object.freeze({status: "invalid", owner: token(owner, "binding.owner"), code: token(code, "binding.code"), message});
}

const resolvedBindingBaseFields = [
  "invocation",
  "correlation",
  "parentInvocation",
  "binding",
  "request",
  "compensation",
  "resolverRevision",
  "resolutionFingerprint",
] as const;

function snapshotResolvedBindingBase<TRequest>(
  input: ResolvedOperationBinding<TRequest>,
  snapshotRequest: (request: TRequest) => TRequest,
): ResolvedOperationBindingBase<TRequest> {
  const invocation = snapshotOperationInvocationRef(input.invocation);
  const binding = snapshotOperationBindingRevisionRef(input.binding);
  const correlation = snapshotOperationCorrelation(input.correlation);
  const compensation = input.compensation === undefined ? undefined : snapshotCompensationAssociation(input.compensation);
  if (compensation && (JSON.stringify(compensation.invocation) !== JSON.stringify(invocation) ||
      JSON.stringify(compensation.correlation) !== JSON.stringify(correlation))) {
    fail("operation_binding_invalid", "Compensation association must belong to this invocation and caller.", "ResolvedOperationBinding.compensation");
  }
  if (
    operationDefinitionRevisionKey(invocation.operation) !==
    operationDefinitionRevisionKey(binding.operation)
  ) {
    fail(
      "operation_binding_invalid",
      "Resolved binding revision does not match the Operation invocation.",
      "ResolvedOperationBinding.binding.operation",
    );
  }
  return Object.freeze({
    invocation,
    correlation,
    ...(compensation === undefined ? {} : {compensation}),
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

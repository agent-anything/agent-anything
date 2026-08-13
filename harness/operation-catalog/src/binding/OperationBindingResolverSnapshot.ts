import type { RegisteredOperation } from "../catalog/index.js";
import type { OperationInvocationContext } from "../identity/index.js";
import type {
  OperationBindingResolution,
  OperationBindingResolverPort,
} from "./OperationBinding.js";

export interface OperationBindingResolverRegistration {
  readonly resolver: OperationBindingResolverPort;
}

export interface OperationBindingResolverSnapshot {
  readonly revision: string;
  readonly resolverIds: readonly string[];
  resolve(input: {
    readonly operation: RegisteredOperation;
    readonly context: OperationInvocationContext;
    readonly request: unknown;
    readonly basis: unknown;
  }): Promise<OperationBindingResolution>;
}

export function createOperationBindingResolverSnapshot(
  revision: string,
  registrations: readonly OperationBindingResolverRegistration[],
): OperationBindingResolverSnapshot {
  requireToken(revision, "OperationBindingResolverSnapshot.revision");
  if (!Array.isArray(registrations)) {
    throw new TypeError("Operation binding resolver registrations must be an array.");
  }
  const resolvers = new Map<string, OperationBindingResolverPort>();
  for (const { resolver } of registrations) {
    if (
      resolver === null ||
      typeof resolver !== "object" ||
      typeof resolver.resolve !== "function"
    ) {
      throw new TypeError("Operation binding resolver implementation is invalid.");
    }
    requireToken(resolver.id, "OperationBindingResolver.id");
    requireToken(resolver.revision, "OperationBindingResolver.revision");
    if (resolvers.has(resolver.id)) {
      throw new TypeError(`Duplicate Operation binding resolver '${resolver.id}'.`);
    }
    resolvers.set(resolver.id, Object.freeze({
      id: resolver.id,
      revision: resolver.revision,
      resolve: resolver.resolve.bind(resolver),
    }));
  }
  return Object.freeze({
    revision,
    resolverIds: Object.freeze([...resolvers.keys()].sort()),
    async resolve(input: {
      readonly operation: RegisteredOperation;
      readonly context: OperationInvocationContext;
      readonly request: unknown;
      readonly basis: unknown;
    }) {
      const binding = input.operation.binding;
      const resolver = resolvers.get(binding.resolverId);
      if (resolver === undefined || resolver.revision !== binding.resolverRevision) {
        return Object.freeze({
          status: "unavailable" as const,
          code: "resolver_unavailable" as const,
          resolverId: binding.resolverId,
        });
      }
      return resolver.resolve({
        registration: input.operation,
        context: input.context,
        request: input.request,
        basis: input.basis,
      });
    },
  });
}

function requireToken(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${field} must be a canonical token.`);
  }
}

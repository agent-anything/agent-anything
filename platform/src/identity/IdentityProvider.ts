import type { Metadata } from "../shared/types.js";
import type { IdentityRef } from "./IdentityRef.js";

export interface ResolveIdentityInput {
  taskId: string;
  metadata: Metadata;
}

export interface IdentityProvider {
  resolve(input: ResolveIdentityInput): Promise<IdentityRef>;
}

export interface CreateAnonymousIdentityProviderInput {
  id?: string;
  displayName?: string;
  metadata?: Metadata;
}

export function createAnonymousIdentityProvider(
  input: CreateAnonymousIdentityProviderInput = {},
): IdentityProvider {
  return {
    async resolve(): Promise<IdentityRef> {
      return {
        id: input.id ?? "anonymous",
        kind: "anonymous",
        displayName: input.displayName ?? "Anonymous",
        metadata: {
          ...input.metadata,
          source: "anonymous-identity-provider",
        },
      };
    },
  };
}

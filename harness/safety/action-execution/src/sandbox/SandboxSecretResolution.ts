import type { ResolvedActionSecret } from "../execution/ActionExecutor.js";
import type { SandboxAttempt } from "./SandboxContracts.js";

export interface ResolveActionSecretsInput {
  readonly attempt: SandboxAttempt;
  readonly references: readonly string[];
}

export interface ActionSecretResolver {
  resolve(
    input: ResolveActionSecretsInput,
  ): Promise<readonly ResolvedActionSecret[]>;
}

export class MissingSecretResolverError extends Error {}

export async function resolveActionSecrets(
  resolver: ActionSecretResolver | undefined,
  attempt: SandboxAttempt,
  references: readonly string[],
): Promise<readonly ResolvedActionSecret[]> {
  if (references.length === 0) return Object.freeze([]);
  if (resolver === undefined) throw new MissingSecretResolverError();
  const resolved = await resolver.resolve({ attempt, references });
  if (!Array.isArray(resolved) || resolved.length !== references.length) {
    throw new TypeError(
      "Resolved secret set does not match requested references.",
    );
  }
  const byReference = new Map<string, string>();
  for (const item of resolved) {
    if (
      item === null ||
      typeof item !== "object" ||
      !references.includes(item.reference) ||
      typeof item.value !== "string" ||
      byReference.has(item.reference)
    ) {
      throw new TypeError("Resolved secret is invalid.");
    }
    byReference.set(item.reference, item.value);
  }
  return Object.freeze(references.map((reference) => Object.freeze({
    reference,
    value: byReference.get(reference)!,
  })));
}

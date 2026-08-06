import type { ActionExecutor } from "../execution/ActionExecutor.js";
import type { ActionRegistrationSnapshot } from "../registration/ActionRegistration.js";
import type { PreparedActionInvocation } from "../canonical/PreparedActionInvocation.js";
import type {
  CapabilityEffectKind,
  SandboxProvider,
  SandboxProviderDescriptor,
  SandboxProviderKind,
} from "./SandboxContracts.js";

export interface RegisteredExecutor {
  readonly key: string;
  readonly executor: ActionExecutor;
}

export interface RegisteredProvider {
  readonly provider: SandboxProvider;
  readonly descriptor: SandboxProviderDescriptor;
}

export function createExecutorRegistry(
  registrations: ActionRegistrationSnapshot,
  executors: readonly ActionExecutor[],
): ReadonlyMap<string, RegisteredExecutor> {
  if (!Array.isArray(executors)) {
    throw new TypeError("Action executors must be an array.");
  }
  const required = new Map<
    string,
    ActionRegistrationSnapshot["registrations"][number]["executor"]
  >();
  for (const registration of registrations.registrations) {
    required.set(
      descriptorKey(registration.executor),
      registration.executor,
    );
  }
  const result = new Map<string, RegisteredExecutor>();
  for (const executor of executors) {
    const key = descriptorKey(executor.descriptor);
    if (!required.has(key)) {
      throw new TypeError(
        `Unregistered ActionExecutor implementation: ${key}.`,
      );
    }
    if (result.has(key)) {
      throw new TypeError(
        `Duplicate ActionExecutor implementation: ${key}.`,
      );
    }
    result.set(key, Object.freeze({ key, executor }));
  }
  return result;
}

export function createProviderRegistry(
  providers: readonly SandboxProvider[],
): ReadonlyMap<SandboxProviderKind, RegisteredProvider> {
  if (!Array.isArray(providers)) {
    throw new TypeError("Sandbox providers must be an array.");
  }
  const result = new Map<SandboxProviderKind, RegisteredProvider>();
  for (const provider of providers) {
    const descriptor = snapshotProviderDescriptor(provider);
    if (result.has(descriptor.kind)) {
      throw new TypeError(
        `Duplicate SandboxProvider kind: ${descriptor.kind}.`,
      );
    }
    result.set(
      descriptor.kind,
      Object.freeze({ provider, descriptor }),
    );
  }
  return result;
}

export function executorKey(
  invocation: PreparedActionInvocation,
): string {
  return descriptorKey({
    id: invocation.executorId,
    version: invocation.executorVersion,
    invocationContractVersion: invocation.contractVersion,
  });
}

function snapshotProviderDescriptor(
  provider: SandboxProvider,
): SandboxProviderDescriptor {
  if (
    !provider ||
    (provider.kind !== "managed" && provider.kind !== "external") ||
    provider.descriptor?.kind !== provider.kind ||
    !isCanonicalToken(provider.descriptor.id) ||
    !isCanonicalToken(provider.descriptor.version)
  ) {
    throw new TypeError("SandboxProvider descriptor is invalid.");
  }
  const versions = snapshotUniqueIntegers(
    provider.descriptor.supportedPolicyVersions,
  );
  const kinds = snapshotEffectKinds(
    provider.descriptor.supportedEffectKinds,
  );
  return Object.freeze({
    id: provider.descriptor.id,
    version: provider.descriptor.version,
    kind: provider.kind,
    supportedPolicyVersions: versions,
    supportedEffectKinds: kinds,
  });
}

function snapshotEffectKinds(
  input: readonly CapabilityEffectKind[],
): readonly CapabilityEffectKind[] {
  if (!Array.isArray(input)) {
    throw new TypeError("Effect kinds must be an array.");
  }
  const allowed = new Set<CapabilityEffectKind>([
    "file_system",
    "process",
    "network",
    "remote_tool",
  ]);
  const values = [...input];
  if (
    values.some((value) => !allowed.has(value)) ||
    new Set(values).size !== values.length
  ) {
    throw new TypeError("Effect kinds are invalid or duplicated.");
  }
  return Object.freeze(values.sort());
}

function snapshotUniqueIntegers(
  input: readonly number[],
): readonly number[] {
  if (
    !Array.isArray(input) ||
    input.some(
      (value) => !Number.isSafeInteger(value) || value < 1,
    )
  ) {
    throw new TypeError("Policy versions must be positive integers.");
  }
  const values = [...input];
  if (new Set(values).size !== values.length) {
    throw new TypeError("Policy versions are duplicated.");
  }
  return Object.freeze(values.sort((left, right) => left - right));
}

function descriptorKey(descriptor: {
  readonly id: string;
  readonly version: string;
  readonly invocationContractVersion: string;
}): string {
  return `${descriptor.id}\u0000${descriptor.version}\u0000${descriptor.invocationContractVersion}`;
}

function isCanonicalToken(input: unknown): input is string {
  return typeof input === "string" &&
    input.length > 0 &&
    input.length <= 1_024 &&
    input === input.trim() &&
    /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(input);
}

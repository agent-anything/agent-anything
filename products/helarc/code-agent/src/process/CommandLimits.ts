import type { CodeAgentCommandLimits } from "./ProcessContracts.js";

export const defaultCodeAgentCommandLimits: CodeAgentCommandLimits = {
  defaultTimeoutMs: 30_000,
  maxTimeoutMs: 120_000,
  maxStdoutBytes: 100_000,
  maxStderrBytes: 100_000,
  maxArgs: 128,
  maxCommandBytes: 65_536,
  maxReasonChars: 1_000,
};

export function resolveCommandLimits(
  input: Partial<CodeAgentCommandLimits> | undefined,
): CodeAgentCommandLimits {
  const limits = {
    ...defaultCodeAgentCommandLimits,
    ...input,
  };

  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(
        "Command limits must be positive safe integers: " + name + ".",
      );
    }
  }

  if (limits.defaultTimeoutMs > limits.maxTimeoutMs) {
    throw new Error(
      "Command default timeout must not exceed the maximum timeout.",
    );
  }

  return limits;
}

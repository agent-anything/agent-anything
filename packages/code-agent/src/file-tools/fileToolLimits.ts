import type { CodeAgentFileToolLimits } from "./FileToolContracts.js";
import { FileToolError } from "./FileToolError.js";

export const defaultCodeAgentFileToolLimits: CodeAgentFileToolLimits = {
  maxListEntries: 1_000,
  maxReadBytes: 1_000_000,
  maxSearchFileBytes: 1_000_000,
  maxSearchMatches: 100,
  maxWriteBytes: 1_000_000,
};

export function resolveFileToolLimits(
  input: Partial<CodeAgentFileToolLimits> | undefined,
): CodeAgentFileToolLimits {
  const limits = {
    ...defaultCodeAgentFileToolLimits,
    ...input,
  };

  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new FileToolError(
        "file_tool_invalid_limits",
        "File tool limits must be positive safe integers.",
        { limit: name, value },
      );
    }
  }

  return limits;
}

import type { CodeAgentFileLimits } from "@agent-anything/helarc-code-agent/source";
import { FileSystemError } from "./FileSystemError.js";

export const defaultCodeAgentFileLimits: CodeAgentFileLimits = {
  maxGlobEntries: 1_000,
  maxReadBytes: 1_000_000,
  maxReadLines: 2_000,
  maxSearchFileBytes: 1_000_000,
  maxGrepMatches: 100,
  maxGrepContextLines: 20,
  maxWriteBytes: 1_000_000,
};

export function resolveFileSystemLimits(
  input: Partial<CodeAgentFileLimits> | undefined,
): CodeAgentFileLimits {
  const limits = {
    ...defaultCodeAgentFileLimits,
    ...input,
  };

  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new FileSystemError(
        "file_system_invalid_limits",
        "File limits must be positive safe integers.",
        { limit: name, value },
      );
    }
  }

  return limits;
}

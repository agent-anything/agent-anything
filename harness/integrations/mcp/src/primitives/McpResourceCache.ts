import type {
  McpResourceReadResult,
  McpSourceSnapshot,
} from "./McpPrimitives.js";
import { McpPrimitiveError } from "./McpPrimitiveError.js";

export function invalidateMcpResourceCache(
  cache: Map<string, McpResourceReadResult>,
  sourceEpoch: number,
  uri: string,
): void {
  const marker = `\u0000resources/read\u0000${uri}\u0000`;
  for (const key of cache.keys()) {
    if (key.startsWith(`${sourceEpoch}\u0000`) && key.includes(marker)) {
      cache.delete(key);
    }
  }
}

export function createMcpResourceCacheKey(
  source: McpSourceSnapshot,
  uri: string,
): string {
  return [
    source.sourceEpoch,
    source.registrationFingerprint,
    source.authorityBindingId,
    "resources/read",
    uri,
  ].join("\u0000");
}

export function getFreshMcpResourceCache(
  cache: Map<string, McpResourceReadResult>,
  key: string,
  nowMs: number,
): McpResourceReadResult | null {
  for (const scope of ["private", "public"] as const) {
    const scopedKey = `${key}\u0000${scope}`;
    const candidate = cache.get(scopedKey);
    if (candidate === undefined) continue;
    if (Date.parse(candidate.cache.expiresAt) > nowMs) return candidate;
    cache.delete(scopedKey);
  }
  return null;
}

export function validateMcpResourceUri(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > 8_192 ||
    /[\u0000-\u001f\u007f]/.test(input)
  ) {
    throw new McpPrimitiveError(
      "mcp_primitive_not_found",
      "MCP Resource URI is invalid.",
    );
  }
  try {
    new URL(input);
  } catch {
    throw new McpPrimitiveError(
      "mcp_primitive_not_found",
      "MCP Resource URI must be absolute.",
    );
  }
  return input;
}

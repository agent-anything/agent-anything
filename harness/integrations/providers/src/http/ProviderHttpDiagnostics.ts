import { createHash } from "node:crypto";
import type { ProviderInteraction, ProviderRequest } from "@agent-anything/model-interaction";

export const MAX_PROVIDER_HTTP_DIAGNOSTIC_MESSAGE_LENGTH = 2_048;
export const MAX_PROVIDER_HTTP_DIAGNOSTIC_ATTRIBUTE_LENGTH = 256;

export interface BoundedProviderHttpDiagnosticText {
  readonly value: string | null;
  readonly truncated: boolean;
}

export interface ProviderHttpRequestDiagnostic {
  readonly revision: "1";
  readonly operation: string;
  readonly interactionKind: ProviderInteraction["kind"];
  readonly sourceMessageCount: number;
  readonly toolResultCount: number;
  readonly nonSucceededToolResultCount: number;
  readonly callableCount: number;
  readonly encodedBodyBytes: number;
  readonly encodedBodySha256: string;
}

export function boundProviderHttpDiagnosticText(
  value: unknown,
  maxLength: number,
  secrets: readonly string[] = [],
): BoundedProviderHttpDiagnosticText {
  if (typeof value !== "string") {
    return Object.freeze({ value: null, truncated: false });
  }
  let normalized = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (const secret of secrets) {
    if (secret.length > 0) normalized = normalized.replaceAll(secret, "[redacted]");
  }
  if (normalized.length === 0) {
    return Object.freeze({ value: null, truncated: false });
  }
  return Object.freeze({
    value: normalized.slice(0, maxLength),
    truncated: normalized.length > maxLength,
  });
}

export function createProviderHttpRequestDiagnostic(input: {
  readonly operation: string;
  readonly request: ProviderRequest;
  readonly encodedBody: string;
}): ProviderHttpRequestDiagnostic {
  let toolResultCount = 0;
  let nonSucceededToolResultCount = 0;
  for (const message of input.request.messages) {
    if (message.role !== "tool") continue;
    toolResultCount += message.content.length;
    nonSucceededToolResultCount += message.content.filter(
      ({ result }) => result.settlement !== "succeeded",
    ).length;
  }
  return Object.freeze({
    revision: "1",
    operation: input.operation,
    interactionKind: input.request.interaction.kind,
    sourceMessageCount: input.request.messages.length,
    toolResultCount,
    nonSucceededToolResultCount,
    callableCount: input.request.interaction.kind === "native_tool_turn"
      ? input.request.interaction.callables.length
      : 0,
    encodedBodyBytes: new TextEncoder().encode(input.encodedBody).byteLength,
    encodedBodySha256: createHash("sha256")
      .update(input.encodedBody, "utf8")
      .digest("hex"),
  });
}

export function renderProviderHttpRequestDiagnostic(
  request: ProviderHttpRequestDiagnostic,
): string {
  return `operation=${request.operation}, interaction=${request.interactionKind}, ` +
    `messages=${request.sourceMessageCount}, toolResults=${request.toolResultCount}, ` +
    `nonSucceededToolResults=${request.nonSucceededToolResultCount}, ` +
    `callables=${request.callableCount}, bytes=${request.encodedBodyBytes}, ` +
    `sha256=${request.encodedBodySha256}`;
}

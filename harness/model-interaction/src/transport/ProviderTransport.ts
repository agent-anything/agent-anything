import { createHash } from "node:crypto";

export interface ProviderTransportLimit {
  readonly maximumBytes: number;
  readonly source: "provider_reported" | "host_configured";
  readonly revision: string;
}

export interface ProviderTransportBinding {
  readonly method: "POST";
  readonly endpoint: string;
  readonly contentType: string;
  readonly encoding: "utf-8";
}

export interface ProviderTransportAccounting {
  readonly requestDigest: string;
  readonly bodyDigest: string;
  readonly encodedBytes: number;
  readonly limit: ProviderTransportLimit;
  readonly disposition: "within_limit" | "exceeds_limit";
  readonly method: "POST";
  readonly endpoint: string;
  readonly contentType: string;
  readonly encoding: "utf-8";
}

export function accountProviderTransport(input: {
  readonly encodedBody: string;
  readonly binding: ProviderTransportBinding;
  readonly limit: ProviderTransportLimit;
}): ProviderTransportAccounting {
  const binding = snapshotBinding(input.binding);
  const limit = snapshotProviderTransportLimit(input.limit);
  const encodedBytes = new TextEncoder().encode(input.encodedBody).byteLength;
  const bodyDigest = sha256(input.encodedBody);
  return Object.freeze({
    requestDigest: sha256(JSON.stringify({ binding, bodyDigest })),
    bodyDigest,
    encodedBytes,
    limit,
    disposition: encodedBytes <= limit.maximumBytes ? "within_limit" : "exceeds_limit",
    ...binding,
  });
}

export function verifyProviderTransportAccounting(input: {
  readonly accounting: ProviderTransportAccounting;
  readonly encodedBody: string;
  readonly binding: ProviderTransportBinding;
}): void {
  const expected = accountProviderTransport({
    encodedBody: input.encodedBody,
    binding: input.binding,
    limit: input.accounting.limit,
  });
  if (
    expected.requestDigest !== input.accounting.requestDigest ||
    expected.bodyDigest !== input.accounting.bodyDigest ||
    expected.encodedBytes !== input.accounting.encodedBytes ||
    expected.disposition !== input.accounting.disposition
  ) {
    throw new TypeError("Provider transport accounting does not match the body dispatched.");
  }
}

export function snapshotProviderTransportLimit(
  input: ProviderTransportLimit,
): ProviderTransportLimit {
  if (!Number.isSafeInteger(input.maximumBytes) || input.maximumBytes <= 0) {
    throw new TypeError("Provider transport limit must be a positive safe integer.");
  }
  if (input.source !== "provider_reported" && input.source !== "host_configured") {
    throw new TypeError("Provider transport limit source is invalid.");
  }
  if (typeof input.revision !== "string" || input.revision.trim().length === 0) {
    throw new TypeError("Provider transport limit revision is required.");
  }
  return Object.freeze({
    maximumBytes: input.maximumBytes,
    source: input.source,
    revision: input.revision.trim(),
  });
}

function snapshotBinding(input: ProviderTransportBinding): ProviderTransportBinding {
  const endpoint = new URL(input.endpoint).toString();
  if (input.method !== "POST" || input.encoding !== "utf-8" ||
      typeof input.contentType !== "string" || input.contentType.trim().length === 0) {
    throw new TypeError("Provider transport binding is invalid.");
  }
  return Object.freeze({
    method: "POST",
    endpoint,
    contentType: input.contentType.trim().toLowerCase(),
    encoding: "utf-8",
  });
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

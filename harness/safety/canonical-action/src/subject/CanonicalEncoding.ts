export type CanonicalEncodingErrorCode =
  | "canonical_encoding_invalid_domain"
  | "canonical_encoding_unsupported_value"
  | "canonical_encoding_cycle"
  | "canonical_encoding_too_deep"
  | "canonical_encoding_too_large"
  | "canonical_encoding_crypto_unavailable"
  | "canonical_encoding_digest_failed";

export class CanonicalEncodingError extends TypeError {
  constructor(
    readonly code: CanonicalEncodingErrorCode,
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "CanonicalEncodingError";
  }
}

const MAX_DEPTH = 64;
const MAX_NODES = 100_000;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const encoder = new TextEncoder();

export function canonicalEncode(domain: string, value: unknown): Uint8Array {
  if (
    typeof domain !== "string" ||
    domain.length === 0 ||
    domain.length > 256 ||
    domain !== domain.trim() ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(domain)
  ) {
    throw encodingError(
      "canonical_encoding_invalid_domain",
      "Canonical encoding requires a versioned domain token.",
      "domain",
    );
  }

  const chunks: Uint8Array[] = [];
  appendAscii(chunks, "C1");
  appendString(chunks, domain);
  encodeValue(value, "$", 0, {
    nodes: 0,
    ancestors: new Set<object>(),
    chunks,
  });
  return concatenate(chunks);
}

export async function createCanonicalSha256Digest(
  domain: string,
  value: unknown,
): Promise<string> {
  const crypto = globalThis.crypto;
  if (crypto?.subtle === undefined) {
    throw encodingError(
      "canonical_encoding_crypto_unavailable",
      "The runtime Web Crypto SHA-256 implementation is unavailable.",
      "crypto.subtle",
    );
  }

  try {
    const encoded = canonicalEncode(domain, value);
    const digestInput = new ArrayBuffer(encoded.byteLength);
    new Uint8Array(digestInput).set(encoded);
    const digest = await crypto.subtle.digest("SHA-256", digestInput);
    return `sha256:${toLowerHex(new Uint8Array(digest))}`;
  } catch (error) {
    if (error instanceof CanonicalEncodingError) throw error;
    throw encodingError(
      "canonical_encoding_digest_failed",
      "Canonical SHA-256 digest calculation failed.",
      "digest",
    );
  }
}

interface EncodingState {
  nodes: number;
  readonly ancestors: Set<object>;
  readonly chunks: Uint8Array[];
}

function encodeValue(
  value: unknown,
  path: string,
  depth: number,
  state: EncodingState,
): void {
  state.nodes += 1;
  if (state.nodes > MAX_NODES) {
    throw encodingError(
      "canonical_encoding_too_large",
      `Canonical value exceeds ${MAX_NODES} nodes.`,
      path,
    );
  }
  if (depth > MAX_DEPTH) {
    throw encodingError(
      "canonical_encoding_too_deep",
      `Canonical value exceeds depth ${MAX_DEPTH}.`,
      path,
    );
  }

  if (value === null) {
    appendAscii(state.chunks, "Z");
    return;
  }
  if (typeof value === "boolean") {
    appendAscii(state.chunks, value ? "T" : "F");
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw unsupported("Canonical numbers must be finite.", path);
    }
    appendAscii(state.chunks, "N");
    appendAscii(state.chunks, `${Object.is(value, -0) ? "0" : value.toString()};`);
    return;
  }
  if (typeof value === "string") {
    appendString(state.chunks, value);
    return;
  }
  if (typeof value !== "object") {
    throw unsupported("Canonical values cannot contain executable or undefined data.", path);
  }
  if (state.ancestors.has(value)) {
    throw encodingError(
      "canonical_encoding_cycle",
      "Canonical values cannot contain cycles.",
      path,
    );
  }

  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      assertDenseArray(value, path);
      appendAscii(state.chunks, `A${value.length}[`);
      value.forEach((entry, index) => encodeValue(entry, `${path}[${index}]`, depth + 1, state));
      appendAscii(state.chunks, "]");
      return;
    }

    assertPlainRecord(value, path);
    const keys = Object.keys(value).sort(compareStrings);
    if (Reflect.ownKeys(value).length !== keys.length) {
      throw unsupported("Canonical objects cannot contain symbol properties.", path);
    }
    appendAscii(state.chunks, `O${keys.length}{`);
    for (const key of keys) {
      const childPath = `${path}.${key}`;
      if (FORBIDDEN_KEYS.has(key)) {
        throw unsupported("Canonical objects cannot contain prototype control keys.", childPath);
      }
      assertDataProperty(value, key, childPath);
      appendString(state.chunks, key);
      encodeValue((value as Record<string, unknown>)[key], childPath, depth + 1, state);
    }
    appendAscii(state.chunks, "}");
  } finally {
    state.ancestors.delete(value);
  }
}

function appendString(chunks: Uint8Array[], value: string): void {
  const bytes = encoder.encode(value);
  appendAscii(chunks, `S${bytes.byteLength}:`);
  chunks.push(bytes);
}

function appendAscii(chunks: Uint8Array[], value: string): void {
  chunks.push(encoder.encode(value));
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function assertDenseArray(value: readonly unknown[], path: string): void {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw unsupported("Canonical arrays cannot contain symbol properties.", path);
    }
    if (key === "length") continue;
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) {
      throw unsupported("Canonical arrays cannot contain additional properties.", `${path}.${key}`);
    }
    assertDataProperty(value, key, `${path}[${key}]`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw unsupported("Canonical arrays cannot be sparse.", `${path}[${index}]`);
    }
  }
}

function assertPlainRecord(value: object, path: string): void {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw unsupported("Canonical objects must use a plain or null prototype.", path);
  }
}

function assertDataProperty(value: object, key: PropertyKey, path: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined ||
    !descriptor.enumerable
  ) {
    throw unsupported("Canonical values require enumerable data properties.", path);
  }
}

function unsupported(message: string, path: string): CanonicalEncodingError {
  return encodingError("canonical_encoding_unsupported_value", message, path);
}

function encodingError(
  code: CanonicalEncodingErrorCode,
  message: string,
  path: string,
): CanonicalEncodingError {
  return new CanonicalEncodingError(code, message, path);
}

function toLowerHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

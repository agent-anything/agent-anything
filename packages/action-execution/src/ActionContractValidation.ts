import {
  canonicalizePermissionAbsolutePath,
  canonicalizePermissionDomain,
  type PermissionEnvironmentPlatform,
} from "@agent-anything/permission/profile";

export type ActionContractValidationCode =
  | "canonical_contract_invalid"
  | "canonical_token_invalid"
  | "canonical_digest_invalid"
  | "canonical_path_invalid"
  | "canonical_endpoint_invalid"
  | "canonical_duplicate"
  | "canonical_effect_invalid"
  | "canonical_operation_invalid"
  | "canonical_permission_invalid"
  | "canonical_assertion_invalid"
  | "safe_summary_invalid";

export class ActionContractValidationError extends TypeError {
  constructor(
    readonly code: ActionContractValidationCode,
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "ActionContractValidationError";
  }
}

const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/;

export function contractError(
  code: ActionContractValidationCode,
  message: string,
  path: string,
): ActionContractValidationError {
  return new ActionContractValidationError(code, message, path);
}

export function assertStrictRecord(
  input: unknown,
  path: string,
  allowedKeys: ReadonlySet<string>,
  code: ActionContractValidationCode,
): asserts input is Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  ) {
    throw contractError(code, `A plain object is required at ${path}.`, path);
  }
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !allowedKeys.has(key)) {
      throw contractError(
        code,
        `Unsupported field at ${path}.${String(key)}.`,
        `${path}.${String(key)}`,
      );
    }
    assertDataProperty(input, key, `${path}.${key}`, code);
  }
}

export function assertCanonicalArray(
  input: unknown,
  path: string,
  code: ActionContractValidationCode,
  maximumLength = 4_096,
): asserts input is readonly unknown[] {
  if (!Array.isArray(input) || input.length > maximumLength) {
    throw contractError(
      code,
      `A dense array with at most ${maximumLength} entries is required at ${path}.`,
      path,
    );
  }
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string") {
      throw contractError(code, `Array symbol properties are not allowed at ${path}.`, path);
    }
    if (key === "length") continue;
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= input.length) {
      throw contractError(
        code,
        `Unsupported array property at ${path}.${key}.`,
        `${path}.${key}`,
      );
    }
    assertDataProperty(input, key, `${path}[${key}]`, code);
  }
  for (let index = 0; index < input.length; index += 1) {
    if (!Object.hasOwn(input, index)) {
      throw contractError(code, `Sparse array entry at ${path}[${index}].`, `${path}[${index}]`);
    }
  }
}

export function validateToken(
  input: unknown,
  path: string,
  code: ActionContractValidationCode = "canonical_token_invalid",
  maximumLength = 1_024,
): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > maximumLength ||
    input !== input.trim() ||
    !TOKEN_PATTERN.test(input)
  ) {
    throw contractError(code, `A canonical token is required at ${path}.`, path);
  }
  return input;
}

export function validateDigest(
  input: unknown,
  path: string,
  code: ActionContractValidationCode = "canonical_digest_invalid",
): string {
  if (
    typeof input !== "string" ||
    !/^(sha256:[0-9a-f]{64}|sha512:[0-9a-f]{128})$/.test(input)
  ) {
    throw contractError(code, `A canonical SHA-256 or SHA-512 digest is required at ${path}.`, path);
  }
  return input;
}

export function validateBoundedText(
  input: unknown,
  path: string,
  code: ActionContractValidationCode,
  maximumLength = 8_192,
): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > maximumLength ||
    input !== input.trim() ||
    input.includes("\0")
  ) {
    throw contractError(code, `Bounded non-empty text is required at ${path}.`, path);
  }
  return input;
}

export function validateBoundedString(
  input: unknown,
  path: string,
  code: ActionContractValidationCode,
  maximumLength = 32_768,
): string {
  if (
    typeof input !== "string" ||
    input.length > maximumLength ||
    input.includes("\0")
  ) {
    throw contractError(code, `A bounded string is required at ${path}.`, path);
  }
  return input;
}

export function validatePlatform(
  input: unknown,
  path: string,
): PermissionEnvironmentPlatform {
  if (input !== "win32" && input !== "posix") {
    throw contractError("canonical_contract_invalid", `Invalid platform at ${path}.`, path);
  }
  return input;
}

export function canonicalizeAbsolutePath(
  input: unknown,
  platform: PermissionEnvironmentPlatform,
  path: string,
): string {
  if (typeof input !== "string") {
    throw contractError("canonical_path_invalid", `A path string is required at ${path}.`, path);
  }
  try {
    return canonicalizePermissionAbsolutePath(input, platform);
  } catch (error) {
    throw contractError(
      "canonical_path_invalid",
      error instanceof Error ? error.message : `Invalid path at ${path}.`,
      path,
    );
  }
}

export function canonicalPathComparisonKey(
  canonicalPath: string,
  platform: PermissionEnvironmentPlatform,
): string {
  return platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath;
}

export function canonicalizeConcreteHost(input: unknown, path: string): string {
  if (typeof input !== "string" || input.length === 0 || input !== input.trim()) {
    throw contractError("canonical_endpoint_invalid", `A host is required at ${path}.`, path);
  }
  const candidate = input.toLowerCase();
  if (
    candidate.startsWith("*.") ||
    candidate.includes("/") ||
    candidate.includes("@") ||
    candidate.includes("?") ||
    candidate.includes("#")
  ) {
    throw contractError(
      "canonical_endpoint_invalid",
      `A concrete host without wildcard, path, credentials, query, or fragment is required at ${path}.`,
      path,
    );
  }
  if (candidate.includes(":")) {
    try {
      const bracketed = candidate.startsWith("[") ? candidate : `[${candidate}]`;
      const hostname = new URL(`http://${bracketed}`).hostname.toLowerCase();
      if (!hostname.startsWith("[") || !hostname.endsWith("]")) throw new Error();
      return hostname;
    } catch {
      throw contractError("canonical_endpoint_invalid", `Invalid IP literal at ${path}.`, path);
    }
  }
  try {
    const host = canonicalizePermissionDomain(candidate);
    if (host.startsWith("*.")) throw new Error();
    return host;
  } catch {
    throw contractError("canonical_endpoint_invalid", `Invalid host at ${path}.`, path);
  }
}

export function validatePort(input: unknown, path: string): number {
  if (!Number.isInteger(input) || (input as number) < 1 || (input as number) > 65_535) {
    throw contractError("canonical_endpoint_invalid", `Port must be 1 through 65535 at ${path}.`, path);
  }
  return input as number;
}

export function compareCanonicalStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertDataProperty(
  input: object,
  key: PropertyKey,
  path: string,
  code: ActionContractValidationCode,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (
    descriptor === undefined ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined ||
    !descriptor.enumerable
  ) {
    throw contractError(code, `Enumerable data property required at ${path}.`, path);
  }
}

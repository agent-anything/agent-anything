import {
  canonicalPathTargetKey,
  createCanonicalExecutableIdentity,
  createCanonicalFileSystemTarget,
  createCanonicalNetworkEndpoint,
  createCanonicalPathIdentity,
  createCanonicalRemoteToolIdentity,
  type CanonicalExecutableIdentity,
  type CanonicalExecutableIdentityInput,
  type CanonicalFileSystemTarget,
  type CanonicalNetworkEndpoint,
  type CanonicalPathIdentity,
  type CanonicalPathIdentityInput,
  type CanonicalRemoteToolIdentity,
} from "./CanonicalIdentity.js";
import {
  assertCanonicalArray,
  assertStrictRecord,
  contractError,
  validateBoundedString,
  validateDigest,
  validateToken,
} from "./ActionContractValidation.js";

export type CanonicalFileEntryOperationKind =
  | "read"
  | "list"
  | "search"
  | "create"
  | "update"
  | "delete";

export interface CanonicalFileEntryOperation {
  readonly sequence: number;
  readonly operation: CanonicalFileEntryOperationKind;
  readonly target: CanonicalFileSystemTarget;
}

export interface CanonicalFileTransferOperation {
  readonly sequence: number;
  readonly operation: "copy" | "move";
  readonly source: CanonicalFileSystemTarget;
  readonly destination: CanonicalFileSystemTarget;
}

export type CanonicalFileOperation =
  | CanonicalFileEntryOperation
  | CanonicalFileTransferOperation;

export interface CanonicalFileSystemOperation {
  readonly schemaVersion: 1;
  readonly kind: "file_system";
  readonly operations: readonly [CanonicalFileOperation, ...CanonicalFileOperation[]];
  readonly parametersDigest: string;
}

export type CanonicalCommandArgument =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "secret_reference"; readonly reference: string };

export interface CanonicalProcessOperation {
  readonly schemaVersion: 1;
  readonly kind: "process";
  readonly operation: "spawn";
  readonly executable: CanonicalExecutableIdentity;
  readonly arguments: readonly CanonicalCommandArgument[];
  readonly cwd: CanonicalPathIdentity;
  readonly environmentDigest: string;
}

export interface CanonicalNetworkOperation {
  readonly schemaVersion: 1;
  readonly kind: "network";
  readonly operation: "request";
  readonly method: string;
  readonly endpoint: CanonicalNetworkEndpoint;
  readonly requestDigest: string;
}

export interface CanonicalRemoteToolOperation {
  readonly schemaVersion: 1;
  readonly kind: "remote_tool";
  readonly operation: "invoke";
  readonly target: CanonicalRemoteToolIdentity;
  readonly argumentsDigest: string;
}

export interface CanonicalSkillOperation {
  readonly schemaVersion: 1;
  readonly kind: "skill";
  readonly operation: "invoke";
  readonly skillId: string;
  readonly skillVersion: string;
  readonly sourceFingerprint: string;
  readonly action: string;
  readonly argumentsDigest: string;
}

export type CanonicalActionOperation =
  | CanonicalFileSystemOperation
  | CanonicalProcessOperation
  | CanonicalNetworkOperation
  | CanonicalRemoteToolOperation
  | CanonicalSkillOperation;

export type CanonicalFileOperationInput =
  | {
      readonly sequence: number;
      readonly operation: CanonicalFileEntryOperationKind;
      readonly target: CanonicalPathIdentityInput;
    }
  | {
      readonly sequence: number;
      readonly operation: "copy" | "move";
      readonly source: CanonicalPathIdentityInput;
      readonly destination: CanonicalPathIdentityInput;
    };

export type CanonicalActionOperationInput =
  | {
      readonly kind: "file_system";
      readonly operations: readonly CanonicalFileOperationInput[];
      readonly parametersDigest: string;
    }
  | {
      readonly kind: "process";
      readonly operation: "spawn";
      readonly executable: CanonicalExecutableIdentityInput;
      readonly arguments: readonly CanonicalCommandArgument[];
      readonly cwd: CanonicalPathIdentityInput;
      readonly environmentDigest: string;
    }
  | {
      readonly kind: "network";
      readonly operation: "request";
      readonly method: string;
      readonly endpoint: CanonicalNetworkEndpoint;
      readonly requestDigest: string;
    }
  | {
      readonly kind: "remote_tool";
      readonly operation: "invoke";
      readonly target: CanonicalRemoteToolIdentity;
      readonly argumentsDigest: string;
    }
  | {
      readonly kind: "skill";
      readonly operation: "invoke";
      readonly skillId: string;
      readonly skillVersion: string;
      readonly sourceFingerprint: string;
      readonly action: string;
      readonly argumentsDigest: string;
    };

export function createCanonicalActionOperation(
  input: CanonicalActionOperationInput,
): CanonicalActionOperation {
  if (input?.kind === "file_system") return createFileSystemOperation(input);
  if (input?.kind === "process") return createProcessOperation(input);
  if (input?.kind === "network") return createNetworkOperation(input);
  if (input?.kind === "remote_tool") return createRemoteToolOperation(input);
  if (input?.kind === "skill") return createSkillOperation(input);
  throw contractError(
    "canonical_operation_invalid",
    "Unknown canonical Action operation kind.",
    "operation.kind",
  );
}

function createFileSystemOperation(
  input: Extract<CanonicalActionOperationInput, { readonly kind: "file_system" }>,
): CanonicalFileSystemOperation {
  assertStrictRecord(
    input,
    "operation",
    new Set(["kind", "operations", "parametersDigest"]),
    "canonical_operation_invalid",
  );
  assertCanonicalArray(input.operations, "operation.operations", "canonical_operation_invalid", 4_096);
  if (input.operations.length === 0) {
    throw contractError(
      "canonical_operation_invalid",
      "A filesystem operation requires at least one entry.",
      "operation.operations",
    );
  }
  const operations = input.operations.map((entry, index) => createFileOperation(entry, index));
  for (let index = 0; index < operations.length; index += 1) {
    if (operations[index]!.sequence !== index) {
      throw contractError(
        "canonical_operation_invalid",
        "Filesystem operation sequence must be contiguous and start at zero.",
        `operation.operations[${index}].sequence`,
      );
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "file_system",
    operations: Object.freeze(operations) as unknown as CanonicalFileSystemOperation["operations"],
    parametersDigest: validateDigest(input.parametersDigest, "operation.parametersDigest"),
  });
}

function createFileOperation(
  input: CanonicalFileOperationInput,
  index: number,
): CanonicalFileOperation {
  const path = `operation.operations[${index}]`;
  validateSequence(input.sequence, `${path}.sequence`);
  if (input.operation === "copy" || input.operation === "move") {
    assertStrictRecord(
      input,
      path,
      new Set(["sequence", "operation", "source", "destination"]),
      "canonical_operation_invalid",
    );
    const source = createCanonicalFileSystemTarget(input.source);
    const destination = createCanonicalFileSystemTarget(input.destination);
    if (canonicalPathTargetKey(source.path) === canonicalPathTargetKey(destination.path)) {
      throw contractError(
        "canonical_operation_invalid",
        "File transfer source and destination must differ.",
        path,
      );
    }
    return Object.freeze({
      sequence: input.sequence,
      operation: input.operation,
      source,
      destination,
    });
  }
  assertStrictRecord(
    input,
    path,
    new Set(["sequence", "operation", "target"]),
    "canonical_operation_invalid",
  );
  if (!("target" in input) || !isFileEntryOperation(input.operation)) {
    throw contractError(
      "canonical_operation_invalid",
      "Invalid filesystem entry operation.",
      `${path}.operation`,
    );
  }
  return Object.freeze({
    sequence: input.sequence,
    operation: input.operation,
    target: createCanonicalFileSystemTarget(input.target),
  });
}

function createProcessOperation(
  input: Extract<CanonicalActionOperationInput, { readonly kind: "process" }>,
): CanonicalProcessOperation {
  assertStrictRecord(
    input,
    "operation",
    new Set(["kind", "operation", "executable", "arguments", "cwd", "environmentDigest"]),
    "canonical_operation_invalid",
  );
  if (input.operation !== "spawn") {
    throw contractError("canonical_operation_invalid", "Invalid process operation.", "operation.operation");
  }
  assertCanonicalArray(input.arguments, "operation.arguments", "canonical_operation_invalid", 16_384);
  const argumentsSnapshot = input.arguments.map((argument, index) => createCommandArgument(argument, index));
  return Object.freeze({
    schemaVersion: 1,
    kind: "process",
    operation: "spawn",
    executable: createCanonicalExecutableIdentity(input.executable),
    arguments: Object.freeze(argumentsSnapshot),
    cwd: createCanonicalPathIdentity(input.cwd),
    environmentDigest: validateDigest(input.environmentDigest, "operation.environmentDigest"),
  });
}

function createNetworkOperation(
  input: Extract<CanonicalActionOperationInput, { readonly kind: "network" }>,
): CanonicalNetworkOperation {
  assertStrictRecord(
    input,
    "operation",
    new Set(["kind", "operation", "method", "endpoint", "requestDigest"]),
    "canonical_operation_invalid",
  );
  if (input.operation !== "request") {
    throw contractError("canonical_operation_invalid", "Invalid network operation.", "operation.operation");
  }
  const method = validateToken(input.method, "operation.method").toUpperCase();
  return Object.freeze({
    schemaVersion: 1,
    kind: "network",
    operation: "request",
    method,
    endpoint: createCanonicalNetworkEndpoint(input.endpoint),
    requestDigest: validateDigest(input.requestDigest, "operation.requestDigest"),
  });
}

function createRemoteToolOperation(
  input: Extract<CanonicalActionOperationInput, { readonly kind: "remote_tool" }>,
): CanonicalRemoteToolOperation {
  assertStrictRecord(
    input,
    "operation",
    new Set(["kind", "operation", "target", "argumentsDigest"]),
    "canonical_operation_invalid",
  );
  if (input.operation !== "invoke") {
    throw contractError("canonical_operation_invalid", "Invalid remote Tool operation.", "operation.operation");
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "remote_tool",
    operation: "invoke",
    target: createCanonicalRemoteToolIdentity(input.target),
    argumentsDigest: validateDigest(input.argumentsDigest, "operation.argumentsDigest"),
  });
}

function createSkillOperation(
  input: Extract<CanonicalActionOperationInput, { readonly kind: "skill" }>,
): CanonicalSkillOperation {
  assertStrictRecord(
    input,
    "operation",
    new Set(["kind", "operation", "skillId", "skillVersion", "sourceFingerprint", "action", "argumentsDigest"]),
    "canonical_operation_invalid",
  );
  if (input.operation !== "invoke") {
    throw contractError("canonical_operation_invalid", "Invalid Skill operation.", "operation.operation");
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "skill",
    operation: "invoke",
    skillId: validateToken(input.skillId, "operation.skillId"),
    skillVersion: validateToken(input.skillVersion, "operation.skillVersion"),
    sourceFingerprint: validateDigest(input.sourceFingerprint, "operation.sourceFingerprint"),
    action: validateBoundedString(input.action, "operation.action", "canonical_operation_invalid"),
    argumentsDigest: validateDigest(input.argumentsDigest, "operation.argumentsDigest"),
  });
}

function createCommandArgument(
  input: CanonicalCommandArgument,
  index: number,
): CanonicalCommandArgument {
  const path = `operation.arguments[${index}]`;
  if (input?.kind === "literal") {
    assertStrictRecord(input, path, new Set(["kind", "value"]), "canonical_operation_invalid");
    return Object.freeze({
      kind: "literal",
      value: validateBoundedString(input.value, `${path}.value`, "canonical_operation_invalid"),
    });
  }
  assertStrictRecord(input, path, new Set(["kind", "reference"]), "canonical_operation_invalid");
  if (input.kind !== "secret_reference") {
    throw contractError("canonical_operation_invalid", "Invalid command argument kind.", `${path}.kind`);
  }
  return Object.freeze({
    kind: "secret_reference",
    reference: validateToken(input.reference, `${path}.reference`),
  });
}

function validateSequence(input: unknown, path: string): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    throw contractError("canonical_operation_invalid", "Invalid operation sequence.", path);
  }
  return input as number;
}

function isFileEntryOperation(input: unknown): input is CanonicalFileEntryOperationKind {
  return input === "read" || input === "list" || input === "search" ||
    input === "create" || input === "update" || input === "delete";
}

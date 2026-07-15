import {
  assertCanonicalArray,
  assertStrictRecord,
  contractError,
  validateBoundedText,
} from "./ActionContractValidation.js";

export interface SafeFileOperationSummary {
  readonly operation: "read" | "list" | "search" | "create" | "update" | "delete" | "copy" | "move";
  readonly sourceLabel: string;
  readonly destinationLabel: string | null;
}

export type SafeActionSummary =
  | {
      readonly schemaVersion: 1;
      readonly kind: "file_system";
      readonly headline: string;
      readonly operations: readonly [SafeFileOperationSummary, ...SafeFileOperationSummary[]];
    }
  | {
      readonly schemaVersion: 1;
      readonly kind: "process";
      readonly headline: string;
      readonly commandDisplay: string;
      readonly cwdDisplay: string;
    }
  | {
      readonly schemaVersion: 1;
      readonly kind: "network";
      readonly headline: string;
      readonly endpointDisplay: string;
    }
  | {
      readonly schemaVersion: 1;
      readonly kind: "remote_tool";
      readonly headline: string;
      readonly serverDisplayName: string;
      readonly toolDisplayName: string;
    }
  | {
      readonly schemaVersion: 1;
      readonly kind: "computation";
      readonly headline: string;
    };

export type SafeActionSummaryInput =
  | Omit<Extract<SafeActionSummary, { readonly kind: "file_system" }>, "schemaVersion" | "operations"> & {
      readonly operations: readonly SafeFileOperationSummary[];
    }
  | Omit<Extract<SafeActionSummary, { readonly kind: "process" }>, "schemaVersion">
  | Omit<Extract<SafeActionSummary, { readonly kind: "network" }>, "schemaVersion">
  | Omit<Extract<SafeActionSummary, { readonly kind: "remote_tool" }>, "schemaVersion">
  | Omit<Extract<SafeActionSummary, { readonly kind: "computation" }>, "schemaVersion">;

export function createSafeActionSummary(input: SafeActionSummaryInput): SafeActionSummary {
  if (input?.kind === "file_system") {
    assertStrictRecord(
      input,
      "safeSummary",
      new Set(["kind", "headline", "operations"]),
      "safe_summary_invalid",
    );
    assertCanonicalArray(input.operations, "safeSummary.operations", "safe_summary_invalid", 4_096);
    if (input.operations.length === 0) {
      throw contractError(
        "safe_summary_invalid",
        "A filesystem summary requires at least one operation.",
        "safeSummary.operations",
      );
    }
    const operations = input.operations.map((operation, index) => createFileSummary(operation, index));
    return Object.freeze({
      schemaVersion: 1,
      kind: "file_system",
      headline: safeText(input.headline, "safeSummary.headline"),
      operations: Object.freeze(operations) as unknown as Extract<
        SafeActionSummary,
        { readonly kind: "file_system" }
      >["operations"],
    });
  }
  if (input?.kind === "process") {
    assertStrictRecord(
      input,
      "safeSummary",
      new Set(["kind", "headline", "commandDisplay", "cwdDisplay"]),
      "safe_summary_invalid",
    );
    return Object.freeze({
      schemaVersion: 1,
      kind: "process",
      headline: safeText(input.headline, "safeSummary.headline"),
      commandDisplay: safeText(input.commandDisplay, "safeSummary.commandDisplay", 16_384),
      cwdDisplay: safeText(input.cwdDisplay, "safeSummary.cwdDisplay"),
    });
  }
  if (input?.kind === "network") {
    assertStrictRecord(
      input,
      "safeSummary",
      new Set(["kind", "headline", "endpointDisplay"]),
      "safe_summary_invalid",
    );
    return Object.freeze({
      schemaVersion: 1,
      kind: "network",
      headline: safeText(input.headline, "safeSummary.headline"),
      endpointDisplay: safeText(input.endpointDisplay, "safeSummary.endpointDisplay"),
    });
  }
  if (input?.kind === "remote_tool") {
    assertStrictRecord(
      input,
      "safeSummary",
      new Set(["kind", "headline", "serverDisplayName", "toolDisplayName"]),
      "safe_summary_invalid",
    );
    return Object.freeze({
      schemaVersion: 1,
      kind: "remote_tool",
      headline: safeText(input.headline, "safeSummary.headline"),
      serverDisplayName: safeText(input.serverDisplayName, "safeSummary.serverDisplayName"),
      toolDisplayName: safeText(input.toolDisplayName, "safeSummary.toolDisplayName"),
    });
  }
  if (input?.kind === "computation") {
    assertStrictRecord(
      input,
      "safeSummary",
      new Set(["kind", "headline"]),
      "safe_summary_invalid",
    );
    return Object.freeze({
      schemaVersion: 1,
      kind: "computation",
      headline: safeText(input.headline, "safeSummary.headline"),
    });
  }
  throw contractError("safe_summary_invalid", "Unknown safe Action summary kind.", "safeSummary.kind");
}

function createFileSummary(
  input: SafeFileOperationSummary,
  index: number,
): SafeFileOperationSummary {
  const path = `safeSummary.operations[${index}]`;
  assertStrictRecord(
    input,
    path,
    new Set(["operation", "sourceLabel", "destinationLabel"]),
    "safe_summary_invalid",
  );
  if (
    input.operation !== "read" && input.operation !== "list" && input.operation !== "search" &&
    input.operation !== "create" && input.operation !== "update" && input.operation !== "delete" &&
    input.operation !== "copy" && input.operation !== "move"
  ) {
    throw contractError("safe_summary_invalid", "Invalid file summary operation.", `${path}.operation`);
  }
  const isTransfer = input.operation === "copy" || input.operation === "move";
  if (isTransfer !== (input.destinationLabel !== null)) {
    throw contractError(
      "safe_summary_invalid",
      "Only copy and move summaries carry a destination label.",
      `${path}.destinationLabel`,
    );
  }
  return Object.freeze({
    operation: input.operation,
    sourceLabel: safeText(input.sourceLabel, `${path}.sourceLabel`),
    destinationLabel: input.destinationLabel === null
      ? null
      : safeText(input.destinationLabel, `${path}.destinationLabel`),
  });
}

function safeText(input: unknown, path: string, maximumLength = 8_192): string {
  return validateBoundedText(input, path, "safe_summary_invalid", maximumLength);
}

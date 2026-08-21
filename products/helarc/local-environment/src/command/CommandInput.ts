import { Buffer } from "node:buffer";
import type { CodeAgentCommandLimits } from "./ProcessContracts.js";

export interface ParsedCommandInput {
  readonly command: string;
  readonly timeoutMs: number;
  readonly description: string | null;
  readonly runInBackground: boolean;
  readonly validationClaim: string | null;
}

export class CommandInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CommandInputError";
  }
}

export function parseCommandInput(
  input: unknown,
  limits: CodeAgentCommandLimits,
): ParsedCommandInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalidInput("Command Action input must be an object.");
  }

  const value = input as Record<string, unknown>;
  const command = requireString(value.command, "command");
  if (command.trim().length === 0) {
    throw invalidInput("Command must not be empty.");
  }

  const commandBytes = Buffer.byteLength(command, "utf8");
  if (commandBytes > limits.maxCommandBytes) {
    throw new CommandInputError(
      "command_size_limit_exceeded",
      "Command exceeds the configured byte limit.",
    );
  }

  const description = optionalString(value.description, "description") ?? null;
  if (description !== null && (description.trim().length === 0 || description.length > limits.maxDescriptionChars)) {
    throw new CommandInputError(
      "command_description_limit_exceeded",
      "Description is empty or exceeds the configured character limit.",
    );
  }
  const validationClaim = optionalString(value.validation_claim, "validation_claim") ?? null;
  if (validationClaim !== null && (validationClaim.trim().length === 0 || validationClaim.length > limits.maxValidationClaimChars)) {
    throw new CommandInputError("command_validation_claim_limit_exceeded", "Validation claim is empty or exceeds the configured character limit.");
  }
  if (value.run_in_background !== undefined && typeof value.run_in_background !== "boolean") {
    throw invalidInput("run_in_background must be a boolean.");
  }

  return {
    command,
    timeoutMs: readTimeout(value.timeout_ms, limits),
    description,
    runInBackground: value.run_in_background === true,
    validationClaim,
  };
}

function readTimeout(
  value: unknown,
  limits: CodeAgentCommandLimits,
): number {
  if (value === undefined) {
    return limits.defaultTimeoutMs;
  }
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw invalidInput("Timeout must be a positive safe integer.");
  }
  if ((value as number) > limits.maxTimeoutMs) {
    throw new CommandInputError(
      "command_timeout_limit_exceeded",
      "Timeout exceeds the configured maximum.",
    );
  }
  return value as number;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw invalidInput(
      "Command Action input field '" + field + "' must be a string.",
    );
  }
  return value;
}

function optionalString(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireString(value, field);
}

function invalidInput(message: string): CommandInputError {
  return new CommandInputError("command_invalid_input", message);
}

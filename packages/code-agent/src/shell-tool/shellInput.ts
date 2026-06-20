import { Buffer } from "node:buffer";
import type {
  CodeAgentShellLimits,
  RunCommandInput,
} from "./ShellToolContracts.js";

export interface ParsedRunCommandInput extends RunCommandInput {
  cwd: string;
  timeoutMs: number;
}

export class ShellInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ShellInputError";
  }
}

export function parseRunCommandInput(
  input: unknown,
  limits: CodeAgentShellLimits,
): ParsedRunCommandInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalidInput("Shell tool input must be an object.");
  }

  const value = input as Record<string, unknown>;
  const command = requireString(value.command, "command");
  if (command.trim().length === 0) {
    throw invalidInput("Command must not be empty.");
  }

  if (!Array.isArray(value.args) || !value.args.every(
    (argument) => typeof argument === "string",
  )) {
    throw invalidInput("Args must be an array of strings.");
  }
  const args = value.args as string[];
  if (args.length > limits.maxArgs) {
    throw new ShellInputError(
      "shell_argument_limit_exceeded",
      "Command exceeds the configured argument count limit.",
    );
  }

  const commandBytes = Buffer.byteLength(command, "utf8")
    + args.reduce(
      (total, argument) => total + Buffer.byteLength(argument, "utf8"),
      0,
    );
  if (commandBytes > limits.maxCommandBytes) {
    throw new ShellInputError(
      "shell_command_limit_exceeded",
      "Command and args exceed the configured byte limit.",
    );
  }

  const reason = requireString(value.reason, "reason");
  if (reason.trim().length === 0) {
    throw invalidInput("Reason must not be empty.");
  }
  if (reason.length > limits.maxReasonChars) {
    throw new ShellInputError(
      "shell_reason_limit_exceeded",
      "Reason exceeds the configured character limit.",
    );
  }

  const rootName = optionalString(value.rootName, "rootName");
  const cwd = optionalString(value.cwd, "cwd") ?? ".";
  const timeoutMs = readTimeout(value.timeoutMs, limits);

  return {
    command,
    args,
    reason,
    cwd,
    timeoutMs,
    ...(rootName === undefined ? {} : { rootName }),
  };
}

function readTimeout(
  value: unknown,
  limits: CodeAgentShellLimits,
): number {
  if (value === undefined) {
    return limits.defaultTimeoutMs;
  }
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw invalidInput("Timeout must be a positive safe integer.");
  }
  if ((value as number) > limits.maxTimeoutMs) {
    throw new ShellInputError(
      "shell_timeout_limit_exceeded",
      "Timeout exceeds the configured maximum.",
    );
  }
  return value as number;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw invalidInput(
      "Shell tool input field '" + field + "' must be a string.",
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

function invalidInput(message: string): ShellInputError {
  return new ShellInputError("shell_invalid_input", message);
}

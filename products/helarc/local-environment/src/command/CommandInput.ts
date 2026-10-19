import { Buffer } from "node:buffer";
import type { CodeAgentCommandLimits } from "./ProcessContracts.js";
import { PROCESS_WAIT_LIMITS } from "./CommandLimits.js";

export interface ParsedCommandInput {
  readonly command: string;
  readonly timeoutMs: number;
  readonly description: string | null;
  readonly runInBackground: boolean;
  readonly waitMs: number;
}

export class CommandInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly path = "",
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
  const extra = Object.keys(value).find(key => !["command", "description", "timeout_ms", "wait_ms", "run_in_background"].includes(key));
  if (extra !== undefined) throw invalidInput("Command input contains an undeclared field.");
  const command = requireString(value.command, "command");
  if (command.trim().length === 0) {
    throw invalidInput("Command must not be blank.", "/command");
  }

  const commandBytes = Buffer.byteLength(command, "utf8");
  if (commandBytes > limits.maxCommandBytes) {
    throw new CommandInputError(
      "command_size_limit_exceeded",
      `Command contains ${commandBytes} UTF-8 bytes; maximum is ${limits.maxCommandBytes}.`, "/command",
    );
  }

  const description = optionalString(value.description, "description") ?? null;
  if (description !== null && (description.trim().length === 0 || description.length > limits.maxDescriptionChars)) {
    throw new CommandInputError(
      "command_description_limit_exceeded",
      `Description must be nonblank and contain at most ${limits.maxDescriptionChars} UTF-16 code units; received ${description.length}.`, "/description",
    );
  }
  if (value.run_in_background !== undefined && typeof value.run_in_background !== "boolean") {
    throw invalidInput("run_in_background must be a boolean.", "/run_in_background");
  }

  return {
    command,
    timeoutMs: readTimeout(value.timeout_ms, limits),
    description,
    runInBackground: value.run_in_background === true,
    waitMs: readProcessWait(value.wait_ms, value.run_in_background === true),
  };
}

export function readProcessWait(value: unknown, background = false): number {
  if (value === undefined) return background ? 0 : PROCESS_WAIT_LIMITS.defaultForegroundMs;
  if (!Number.isSafeInteger(value) || (value !== 0 && ((value as number) < PROCESS_WAIT_LIMITS.minimumPositiveMs || (value as number) > PROCESS_WAIT_LIMITS.maximumMs))) throw invalidInput(`wait_ms must be zero or ${PROCESS_WAIT_LIMITS.minimumPositiveMs} through ${PROCESS_WAIT_LIMITS.maximumMs} ms.`, "/wait_ms");
  if (background && value !== 0) throw invalidInput(`Background launch requires omitted or zero wait_ms; received ${value} ms with run_in_background=true.`, "/wait_ms");
  return value as number;
}

function readTimeout(
  value: unknown,
  limits: CodeAgentCommandLimits,
): number {
  if (value === undefined) {
    return limits.defaultTimeoutMs;
  }
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw invalidInput("Timeout must be a positive safe integer.", "/timeout_ms");
  }
  if ((value as number) > limits.maxTimeoutMs) {
    throw new CommandInputError(
      "command_timeout_limit_exceeded",
      `Received timeout_ms=${value} ms; allowed range is 1 through ${limits.maxTimeoutMs} ms. Omitting timeout_ms uses ${limits.defaultTimeoutMs} ms.`, "/timeout_ms",
    );
  }
  return value as number;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw invalidInput(
      "Command Action input field '" + field + "' must be a string.",
      `/${field}`,
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

function invalidInput(message: string, path = ""): CommandInputError {
  return new CommandInputError("command_invalid_input", message, path);
}

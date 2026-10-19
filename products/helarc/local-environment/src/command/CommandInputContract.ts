import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { CommandInputError, parseCommandInput } from "./CommandInput.js";
import { PROCESS_WAIT_LIMITS, resolveCommandLimits } from "./CommandLimits.js";
import type { CodeAgentCommandLimits } from "./ProcessContracts.js";

/** Pure definitions and validation; constructing this does not acquire a process capability. */
export function createCommandInputContract(input?: Partial<CodeAgentCommandLimits>) {
  const limits = resolveCommandLimits(input);
  const constraints = Object.freeze({
    timeout: Object.freeze({minimumMs: 1, maximumMs: limits.maxTimeoutMs, defaultMs: limits.defaultTimeoutMs}),
    wait: Object.freeze({...PROCESS_WAIT_LIMITS, backgroundMs: 0}),
    command: Object.freeze({maximumUtf8Bytes: limits.maxCommandBytes}),
    description: Object.freeze({maximumUtf16CodeUnits: limits.maxDescriptionChars}),
    capacity: Object.freeze({maximumActive: limits.maxActiveTasks, scope: "process_manager" as const}),
  });
  const ref = Object.freeze({owner: "helarc-command", kind: "contribution", id: "command-input",
    revision: `sha256:${createHash("sha256").update(JSON.stringify(constraints)).digest("hex")}`});
  const issueHint = (value: unknown, issue: {readonly path: string}): string | null => {
    if (!isRecord(value)) return null;
    switch (issue.path) {
      case "/timeout_ms": return `timeout_ms allows integer milliseconds from 1 through ${constraints.timeout.maximumMs}; omission uses ${constraints.timeout.defaultMs} ms.${safeNumber(value.timeout_ms, " Requested", " ms.")}`;
      case "/wait_ms": return `wait_ms is zero or ${constraints.wait.minimumPositiveMs} through ${constraints.wait.maximumMs} ms; omission uses ${value.run_in_background === true ? 0 : constraints.wait.defaultForegroundMs} ms. With run_in_background=true, omit wait_ms or use zero.${safeNumber(value.wait_ms, " Requested", " ms.")}`;
      case "/command": return `command must be nonblank and at most ${constraints.command.maximumUtf8Bytes} UTF-8 bytes.${typeof value.command === "string" ? ` Received ${Buffer.byteLength(value.command, "utf8")} bytes.` : ""}`;
      case "/description": return `description must be nonblank and at most ${constraints.description.maximumUtf16CodeUnits} UTF-16 code units.${typeof value.description === "string" ? ` Received ${value.description.length} code units.` : ""}`;
      default: return null;
    }
  };
  return Object.freeze({constraints, ref, issueHint,
    validate(value: unknown) {
      try { parseCommandInput(value, limits); return Object.freeze({status: "valid" as const}); }
      catch (error) {
        if (!(error instanceof CommandInputError)) throw error;
        const field = isRecord(value) ? value[error.path.slice(1)] : value;
        return Object.freeze({status: "invalid" as const, issues: Object.freeze([Object.freeze({
          path: error.path, reason: "constraint" as const, expected: error.message,
          received: category(field), hint: issueHint(value, error),
        })])});
      }
    },
  });
}

export type CommandInputContract = ReturnType<typeof createCommandInputContract>;
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function safeNumber(value: unknown, prefix: string, suffix: string): string { return typeof value === "number" && Number.isFinite(value) ? `${prefix} ${value}${suffix}` : ""; }
function category(value: unknown) {
  if (value === undefined) return "missing" as const;
  if (value === null) return "null" as const;
  if (Array.isArray(value)) return "array" as const;
  if (typeof value === "number") return Number.isInteger(value) ? "integer" as const : "number" as const;
  if (typeof value === "string") return "string" as const;
  if (typeof value === "boolean") return "boolean" as const;
  return "object" as const;
}

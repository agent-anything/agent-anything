import type { ToolCall } from "@agent-anything/tools";
import type { NetDoctorToolInput } from "./toolSchemas.js";

export function readNetDoctorToolInput(call: ToolCall): NetDoctorToolInput {
  if (!isRecord(call.input)) {
    throw new Error("Tool input must be an object.");
  }

  const { target, host, port, protocol, symptom } = call.input;

  if (typeof target !== "string" || target.length === 0) {
    throw new Error("Tool input target is required.");
  }

  if (typeof host !== "string" || host.length === 0) {
    throw new Error("Tool input host is required.");
  }

  if (port !== null && typeof port !== "number") {
    throw new Error("Tool input port must be a number or null.");
  }

  if (protocol !== null && typeof protocol !== "string") {
    throw new Error("Tool input protocol must be a string or null.");
  }

  if (typeof symptom !== "string") {
    throw new Error("Tool input symptom must be a string.");
  }

  return {
    target,
    host,
    port,
    protocol,
    symptom,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

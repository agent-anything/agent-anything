import type { Metadata } from "@agent-anything/shared";
import type { RuntimeEvent } from "@agent-anything/agent-core";
import type { NetDoctorProgressUpdate } from "./NetDoctorProgressUpdate.js";

export function mapRuntimeEventToNetDoctorProgress(
  event: RuntimeEvent,
): NetDoctorProgressUpdate | null {
  const payload = event.payload;

  switch (event.name) {
    case "task.started":
      return createUpdate(event, {
        phase: "starting",
        status: "running",
        message: "Starting NetDoctor diagnosis.",
      });
    case "loop.iteration.started":
      return createUpdate(event, {
        phase: "planning",
        status: "running",
        message: `Planning diagnostic step ${readNumber(payload, "iteration") ?? event.sequence}.`,
      });
    case "planner.started":
      return createUpdate(event, {
        phase: "planning",
        status: "running",
        message: "Asking provider for the next diagnostic step.",
      });
    case "planner.finished":
      return createUpdate(event, {
        phase: "planning",
        status: readStatus(payload),
        message: readStatus(payload) === "failed"
          ? "Provider planning failed."
          : "Provider planning finished.",
        errorCode: readString(payload, "errorCode"),
      });
    case "plan.created":
      return createUpdate(event, {
        phase: "planning",
        status: "succeeded",
        message: `Created ${readString(payload, "planStepKind") ?? "diagnostic"} plan.`,
      });
    case "tool.started":
      return createUpdate(event, {
        phase: "tool",
        status: "running",
        message: `Running ${readToolName(payload) ?? "diagnostic tool"}.`,
        toolName: readToolName(payload),
      });
    case "tool.finished":
      return createUpdate(event, {
        phase: "tool",
        status: readStatus(payload),
        message: readStatus(payload) === "failed"
          ? `${readToolName(payload) ?? "Diagnostic tool"} failed.`
          : `${readToolName(payload) ?? "Diagnostic tool"} finished.`,
        toolName: readToolName(payload),
      });
    case "observation.created":
      return createUpdate(event, {
        phase: "observing",
        status: "succeeded",
        message: "Captured diagnostic observation.",
        evidenceRefs: readStringArray(payload, "evidenceRefs"),
      });
    case "context.updated":
      return createUpdate(event, {
        phase: "observing",
        status: "succeeded",
        message: "Updated diagnosis context.",
        evidenceRefs: readStringArray(payload, "evidenceRefs"),
      });
    case "task.completed":
      return createUpdate(event, {
        phase: "completed",
        status: "succeeded",
        message: "NetDoctor diagnosis completed.",
        output: payload.output ?? null,
        evidenceRefs: readStringArray(payload, "evidenceRefs"),
      });
    case "task.failed":
      return createUpdate(event, {
        phase: "failed",
        status: "failed",
        message: "NetDoctor diagnosis failed.",
        errorCode: readString(payload, "errorCode"),
        evidenceRefs: readStringArray(payload, "evidenceRefs"),
      });
    default:
      return null;
  }
}

function createUpdate(
  event: RuntimeEvent,
  input: {
    phase: NetDoctorProgressUpdate["phase"];
    status: NetDoctorProgressUpdate["status"];
    message: string;
    toolName?: string | null;
    evidenceRefs?: string[];
    output?: unknown | null;
    errorCode?: string | null;
  },
): NetDoctorProgressUpdate {
  return {
    taskId: event.taskId,
    sequence: event.sequence,
    phase: input.phase,
    status: input.status,
    message: input.message,
    toolName: input.toolName ?? null,
    evidenceRefs: input.evidenceRefs ?? [],
    output: input.output ?? null,
    errorCode: input.errorCode ?? null,
    metadata: {
      runtimeEventId: event.id,
      runtimeEventName: event.name,
    },
  };
}

function readStatus(payload: Metadata): NetDoctorProgressUpdate["status"] {
  return payload.status === "failed" ? "failed" : "succeeded";
}

function readToolName(payload: Metadata): string | null {
  return readString(payload, "toolName");
}

function readString(payload: Metadata, key: string): string | null {
  return typeof payload[key] === "string" ? payload[key] : null;
}

function readNumber(payload: Metadata, key: string): number | null {
  return typeof payload[key] === "number" ? payload[key] : null;
}

function readStringArray(payload: Metadata, key: string): string[] {
  return Array.isArray(payload[key])
    ? payload[key].filter((item): item is string => typeof item === "string")
    : [];
}

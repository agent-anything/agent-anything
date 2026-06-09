import type { RuntimeEvent } from "@agent-anything/platform";
import { describe, expect, it } from "vitest";
import { mapRuntimeEventToNetDoctorProgress } from "./mapRuntimeEventToNetDoctorProgress.js";

describe("mapRuntimeEventToNetDoctorProgress", () => {
  it("maps planner events to planning progress", () => {
    expect(mapRuntimeEventToNetDoctorProgress(createEvent("planner.started"))).toMatchObject({
      phase: "planning",
      status: "running",
      message: "Asking provider for the next diagnostic step.",
    });

    expect(
      mapRuntimeEventToNetDoctorProgress(createEvent("planner.finished", {
        status: "failed",
        errorCode: "planner_failed",
      })),
    ).toMatchObject({
      phase: "planning",
      status: "failed",
      message: "Provider planning failed.",
      errorCode: "planner_failed",
    });
  });

  it("maps tool events with current tool name", () => {
    expect(
      mapRuntimeEventToNetDoctorProgress(createEvent("tool.started", {
        toolName: "netDoctor.dnsLookup",
      })),
    ).toMatchObject({
      phase: "tool",
      status: "running",
      message: "Running netDoctor.dnsLookup.",
      toolName: "netDoctor.dnsLookup",
    });

    expect(
      mapRuntimeEventToNetDoctorProgress(createEvent("tool.finished", {
        status: "succeeded",
        toolName: "netDoctor.dnsLookup",
      })),
    ).toMatchObject({
      phase: "tool",
      status: "succeeded",
      message: "netDoctor.dnsLookup finished.",
      toolName: "netDoctor.dnsLookup",
    });
  });

  it("maps observation and context events with evidence refs", () => {
    const update = mapRuntimeEventToNetDoctorProgress(createEvent("observation.created", {
      evidenceRefs: ["evidence_dns"],
    }));

    expect(update).toMatchObject({
      phase: "observing",
      status: "succeeded",
      message: "Captured diagnostic observation.",
      evidenceRefs: ["evidence_dns"],
    });
  });

  it("maps task completion and failure", () => {
    expect(
      mapRuntimeEventToNetDoctorProgress(createEvent("task.completed", {
        reportRef: "artifact_report_001",
        evidenceRefs: ["evidence_dns"],
      })),
    ).toMatchObject({
      phase: "completed",
      status: "succeeded",
      reportRef: "artifact_report_001",
      evidenceRefs: ["evidence_dns"],
    });

    expect(
      mapRuntimeEventToNetDoctorProgress(createEvent("task.failed", {
        errorCode: "planner_failed",
      })),
    ).toMatchObject({
      phase: "failed",
      status: "failed",
      errorCode: "planner_failed",
    });
  });

  it("ignores unsupported events safely", () => {
    expect(mapRuntimeEventToNetDoctorProgress(createEvent("permission.requested"))).toBeNull();
  });
});

function createEvent(
  name: RuntimeEvent["name"],
  payload: RuntimeEvent["payload"] = {},
): RuntimeEvent {
  return {
    id: "runtime_event_001",
    name,
    taskId: "task_001",
    sequence: 1,
    timestamp: "2026-06-09T00:00:00.000Z",
    payload,
  };
}

import { describe, expect, it } from "vitest";
import {
  assembleEvaluationCapture,
  createEvaluationCapturePolicy,
  projectEvaluationCapture,
  type EvaluationCaptureContribution,
} from "./index.js";

const TIME = "2026-08-01T00:00:00.000Z";

describe("Evaluation Capture", () => {
  it("settles every declared slot and keeps missing measurements explicit", () => {
    const policy = createPolicy();
    const result = assembleEvaluationCapture({
      ref: ref("capture"),
      trialRef: ref("trial"),
      targetSnapshotRef: ref("target"),
      caseRef: ref("case"),
      policy,
      environmentRef: ref("environment"),
      contributions: [captured("outcome", { status: "failed", code: "tool_failed" })],
      measurements: [],
      startedAt: TIME,
      completedAt: TIME,
      limitations: [],
      metadata: {},
    });

    expect(result.status).toBe("partial");
    expect(result.capture.slots.map((slot) => [slot.slotId, slot.status])).toEqual([
      ["outcome", "captured"],
      ["usage", "missing"],
    ]);
    expect(result.capture.slots.map((slot) => slot.retention)).toEqual([
      "report",
      "campaign",
    ]);
    expect(result.capture.sensitivities).toEqual(["internal", "public"]);
    expect(result.capture.measurements).toEqual([]);
    expect(projectEvaluationCapture(result.capture).slots[0]).not.toHaveProperty("value");
  });

  it("fails mandatory invalid or unsafe content without leaking it", () => {
    const policy = createPolicy();
    const result = assembleEvaluationCapture({
      ref: ref("capture"),
      trialRef: ref("trial"),
      targetSnapshotRef: ref("target"),
      caseRef: ref("case"),
      policy,
      environmentRef: ref("environment"),
      contributions: [captured("outcome", { rootPath: "C:\\secret\\workspace" })],
      measurements: [],
      startedAt: TIME,
      completedAt: TIME,
      limitations: [],
      metadata: {},
    });

    expect(result.status).toBe("failed");
    expect(result.capture.slots[0].status).toBe("invalid");
    expect(JSON.stringify(result.capture)).not.toContain("C:\\\\secret");
  });

  it("rejects duplicate contributions deterministically", () => {
    const contribution = captured("outcome", { status: "succeeded" });
    const result = assembleEvaluationCapture({
      ref: ref("capture"),
      trialRef: ref("trial"),
      targetSnapshotRef: ref("target"),
      caseRef: ref("case"),
      policy: createPolicy(),
      environmentRef: ref("environment"),
      contributions: [contribution, contribution],
      measurements: [],
      startedAt: TIME,
      completedAt: TIME,
      limitations: [],
      metadata: {},
    });

    expect(result.status).toBe("failed");
    expect(result.capture.slots[0].reason?.code).toBe("duplicate_contribution");
  });

  it("does not admit sensitive Capture metadata or missing-data details", () => {
    const base = {
      ref: ref("capture"),
      trialRef: ref("trial"),
      targetSnapshotRef: ref("target"),
      caseRef: ref("case"),
      policy: createPolicy(),
      environmentRef: ref("environment"),
      measurements: [],
      startedAt: TIME,
      completedAt: TIME,
      limitations: [],
    };

    expect(() => assembleEvaluationCapture({
      ...base,
      contributions: [captured("outcome", { status: "succeeded" })],
      metadata: { rootPath: "D:/private/workspace" },
    })).toThrow(/rootPath/);
    const result = assembleEvaluationCapture({
      ...base,
      contributions: [{
        slotId: "outcome",
        owner: "product",
        schemaRef: schema("product-outcome"),
        sensitivity: "internal",
        status: "unavailable",
        content: null,
        reason: {
          code: "source_unavailable",
          message: "Source unavailable.",
          sourceOwner: "product",
          details: { apiKey: "secret" },
        },
      }],
      metadata: {},
    });

    expect(result.status).toBe("failed");
    expect(JSON.stringify(result.capture)).not.toContain("secret");
  });

  it("fails closed for schema, sensitivity, size, and mandatory-redaction violations", () => {
    const valid = captured("outcome", { status: "succeeded" });
    const candidates: readonly EvaluationCaptureContribution[] = [
      { ...valid, schemaRef: schema("wrong-schema") },
      { ...valid, sensitivity: "private" },
      {
        ...valid,
        content: {
          kind: "inline",
          value: { payload: "x".repeat(2_048) },
        },
      },
      {
        ...valid,
        status: "redacted",
        content: null,
        reason: {
          code: "capture_redacted",
          message: "The mandatory value was redacted.",
          sourceOwner: "product",
          details: {},
        },
      },
    ];

    for (const contribution of candidates) {
      const result = assembleEvaluationCapture({
        ref: ref("capture"),
        trialRef: ref("trial"),
        targetSnapshotRef: ref("target"),
        caseRef: ref("case"),
        policy: createPolicy(),
        environmentRef: ref("environment"),
        contributions: [contribution],
        measurements: [],
        startedAt: TIME,
        completedAt: TIME,
        limitations: [],
        metadata: {},
      });

      expect(result.status).toBe("failed");
      expect(result.capture.status).toBe("failed");
      expect(result.capture.failures.map((failure) => failure.code)).toContain(
        "evaluation_capture_failed",
      );
    }
  });
});

function createPolicy() {
  return createEvaluationCapturePolicy({
    ref: ref("capture-policy"),
    slots: [
      {
        id: "outcome",
        owner: "product",
        schemaRef: schema("product-outcome"),
        required: true,
        maximumSensitivity: "internal",
        contentMode: "inline",
        retention: "report",
        maximumBytes: 1_024,
        optionalOmission: "complete",
        consumers: [{ kind: "grader", ref: ref("outcome-grader") }],
      },
      {
        id: "usage",
        owner: "provider",
        schemaRef: schema("provider-usage"),
        required: false,
        maximumSensitivity: "internal",
        contentMode: "inline",
        retention: "campaign",
        maximumBytes: 1_024,
        optionalOmission: "partial",
        consumers: [{ kind: "metric", ref: ref("token-metric") }],
      },
    ],
    createdAt: TIME,
    metadata: {},
    limitations: [],
  });
}

function captured(slotId: string, value: Record<string, string>): EvaluationCaptureContribution {
  return {
    slotId,
    owner: "product",
    schemaRef: schema("product-outcome"),
    sensitivity: "internal",
    status: "captured",
    content: { kind: "inline", value },
    reason: null,
  };
}

function ref(id: string) {
  return { id, revision: "v1" };
}

function schema(schemaId: string) {
  return { schemaId, revision: "v1" };
}

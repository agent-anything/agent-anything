import { describe, expect, it } from "vitest";
import { createHelarcClarificationContribution } from "./HelarcClarificationInteraction.js";

const NOW = "2026-08-21T00:00:00.000Z";

describe("Helarc clarification Interaction", () => {
  it("keeps one exact Tool request correlated through submission and result", () => {
    const contribution = createHelarcClarificationContribution(NOW);
    const protocol = contribution.protocol.protocol;
    const request = protocol.createRequest({
      requestId: "clarification-1",
      requestVersion: 1,
      subject: clarification(),
      subjectRef: {
        owner: "helarc",
        kind: "clarification_tool_call",
        id: "tool-call-1",
        revision: "1",
      },
      correlation: {
        kind: "owner_operation",
        owner: "test",
        operationId: "clarification-test",
        operationRevision: "1",
      },
      parentRunAction: null,
      presentation: clarification(),
      expiresAt: null,
      createdAt: NOW,
    });
    const submission = protocol.validateSubmission(request, {
      answers: [{
        question_id: "scope",
        selected_labels: ["Current package"],
        text: "Include its tests.",
      }],
    });
    const resolution = protocol.resolve({
      request,
      submissionId: "submission-1",
      submission,
      receivedAt: NOW,
    });

    expect(protocol.apply({
      request,
      resolution,
      resolvedAt: NOW,
    })).toEqual({
      request_ref: "helarc:clarification:clarification-1@1",
      answers: [{
        question_id: "scope",
        selected_labels: ["Current package"],
        text: "Include its tests.",
      }],
    });
    expect(contribution.tool.descriptor.binding).toMatchObject({
      kind: "interaction",
      protocol: { owner: "helarc", kind: "clarification", revision: "1" },
      blockingScope: "run",
    });
  });

  it("rejects answers that do not match the exact active question options", () => {
    const protocol = createHelarcClarificationContribution(NOW).protocol.protocol;
    const request = protocol.createRequest({
      requestId: "clarification-2",
      requestVersion: 1,
      subject: clarification(),
      subjectRef: { owner: "helarc", kind: "clarification_tool_call", id: "tool-call-2", revision: "1" },
      correlation: { kind: "owner_operation", owner: "test", operationId: "clarification-test", operationRevision: "1" },
      parentRunAction: null,
      presentation: clarification(),
      expiresAt: null,
      createdAt: NOW,
    });

    expect(() => protocol.validateSubmission(request, {
      answers: [{ question_id: "scope", selected_labels: ["Unknown"], text: null }],
    })).toThrow("outside the active request");
  });
});

function clarification() {
  return {
    questions: [{
      id: "scope",
      prompt: "Which scope should be changed?",
      options: [{
        label: "Current package",
        description: "Limit the change to the active package.",
      }],
      allow_multiple: false,
    }],
  };
}

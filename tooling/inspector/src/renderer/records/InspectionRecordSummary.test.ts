import {describe, expect, it} from "vitest";
import {payloadSummary} from "./InspectionRecordSummary.js";

describe("context record summaries", () => {
  it("distinguishes exact sources and owner representations", () => {
    const base = {kind: "working_selection" as const, requestId: "request", sectionId: "report", position: 0,
      digest: "digest", obligationCount: 1, relationshipCount: 2, protection: []};
    expect(payloadSummary({...base, representation: "exact"})).toBe("Exact source / 1 preservation requirements / 2 relationships");
    expect(payloadSummary({...base, representation: "owner_form"})).toBe("Owner representation / 1 preservation requirements / 2 relationships");
  });
  it("keeps unknown measurement and included versus settled facts distinct", () => {
    expect(payloadSummary({kind: "context_planning", requestId: "request", planningId: "plan", disposition: "unresolved",
      measurement: "unavailable", inputTokens: null, proxyBytes: 42, workingTarget: null, anchorRequestId: null, limitationCount: 1}))
      .toBe("Context unresolved / unavailable / input tokens unknown");
    expect(payloadSummary({kind: "working_view", requestId: "request", recipientRunId: "child", version: 1,
      selectionCount: 3, groupCount: 1, stage: "included"})).toBe("Working input / 3 selections / 1 native groups / included");
    expect(payloadSummary({kind: "native_group", requestId: "request", turnId: "turn", callCount: 2,
      settledCallCount: 1, status: "unsettled", protection: "active_exchange"})).toBe("Native exchange / 1 of 2 calls settled / unsettled");
  });
});

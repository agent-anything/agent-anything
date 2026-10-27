import { describe, expect, it } from "vitest";
import type { ProviderRequest } from "@agent-anything/model-interaction";
import type { ExecutionFlowObservation } from "@agent-anything/observability/execution-flow";
import { recordContinuedModelInput } from "./ModelInputContinuation.js";

describe("Continued model input evidence", () => {
  it("links the actual accepted arrangement to the new request without implying dispatch or adoption", () => {
    const events: ExecutionFlowObservation[] = [];
    recordContinuedModelInput({ id: "accepted-1", runId: "child", sourceRequestId: "request-old" },
      { requestId: "request-new", composition: { id: "composition-new" } } as ProviderRequest,
      { observer: { observe: event => { events.push(event); } } });
    const serialized = JSON.stringify(events);
    expect(serialized).toContain("accepted-1");
    expect(serialized).toContain("request-old");
    expect(serialized).toContain("request-new");
    expect(serialized).toContain("composition-new");
    expect(events.filter(event => event.kind !== "definition").every(event => event.runId === "child")).toBe(true);
    expect(serialized).not.toContain("input_adopted");
    expect(serialized).not.toContain("provider_attempt");
  });
});

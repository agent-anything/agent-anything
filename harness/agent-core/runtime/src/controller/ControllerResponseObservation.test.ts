import { describe, expect, it } from "vitest";
import type { ProviderDeliveryProgress } from "@agent-anything/model-interaction";
import { ControllerResponseDelivery, type ControllerResponseObservation } from "./ControllerResponseObservation.js";

describe("ControllerResponseDelivery", () => {
  it("ignores superseded, duplicate, foreign and post-settlement parts", () => {
    const events: ControllerResponseObservation[] = [];
    const delivery = new ControllerResponseDelivery("run", "controller", { mode: "streaming", observer: { observe: (event) => { events.push(event); } } });
    const first = delivery.invocation("first", "request", new AbortController().signal);
    const second = delivery.invocation("second", "request", new AbortController().signal);
    const delta: ProviderDeliveryProgress = { kind: "text_delta", invocationId: "second", requestId: "request",
      controllerRequestId: "controller", sequence: 1, partId: "text:0", offset: 0, text: "Hello" };
    first.observer!.observe({ ...delta, invocationId: "first" });
    second.observer!.observe({ ...delta, controllerRequestId: "foreign" });
    second.observer!.observe(delta);
    second.observer!.observe(delta);
    second.observer!.observe({ kind: "settled", invocationId: "second", requestId: "request", controllerRequestId: "controller",
      sequence: 2, disposition: "completed", code: null, parts: [{ partId: "text:0", turnId: "turn", contentBlockOrdinal: 0 }] });
    second.observer!.observe({ ...delta, sequence: 3 });
    delivery.finish("validated", [{ id: "item", kind: "assistant_text", turnId: "turn", contentBlockOrdinal: 0, text: "Hello", metadata: {} }]);
    second.observer!.observe({ ...delta, sequence: 4 });
    delivery.finish("validated");
    expect(events).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({ kind: "interpretation", disposition: "validated", invocationId: "second", parts: [{ modelItemId: "item" }] });
  });

  it("isolates simultaneous Root and Child observations and discards cancelled text", () => {
    const events: ControllerResponseObservation[] = [];
    const root = new ControllerResponseDelivery("root", "root-controller", { mode: "streaming", observer: { observe: (event) => { events.push(event); } } });
    const child = new ControllerResponseDelivery("child", "child-controller", { mode: "streaming", observer: { observe: (event) => { events.push(event); } } });
    const abort = new AbortController();
    const rootOptions = root.invocation("root-attempt", "root-request", new AbortController().signal);
    const childOptions = child.invocation("child-attempt", "child-request", abort.signal);
    const rootDelta: ProviderDeliveryProgress = { kind: "text_delta", invocationId: "root-attempt", requestId: "root-request",
      controllerRequestId: "root-controller", sequence: 1, partId: "text:0", offset: 0, text: "Root" };
    rootOptions.observer!.observe(rootDelta);
    childOptions.observer!.observe(rootDelta);
    abort.abort();
    childOptions.observer!.observe({ ...rootDelta, invocationId: "child-attempt", requestId: "child-request", controllerRequestId: "child-controller" });
    childOptions.observer!.observe({ kind: "settled", invocationId: "child-attempt", requestId: "child-request", controllerRequestId: "child-controller",
      sequence: 2, disposition: "cancelled", code: null, parts: [] });
    expect(events.map((event) => event.runId)).toEqual(["root", "child"]);
    child.finish("cancelled");
    expect(events).toHaveLength(2);
  });
});

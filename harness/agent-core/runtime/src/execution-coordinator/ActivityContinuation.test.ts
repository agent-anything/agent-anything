import {describe, expect, it, vi} from "vitest";
import {createModelActivityBinding} from "../model-access/ModelActivityBinding.js";
import {ActivityContinuationCoordinator, createActivityContinuationArrangement} from "./ActivityContinuation.js";
import type {ActivityCheckpointPort} from "../activity/ActivityCheckpoint.js";

const activity = createModelActivityBinding({runId: "root", activityId: "decision-1", purpose: "task",
  owner: {kind: "task_decision", inputOwner: "context_representation"}});
const arrangement = () => createActivityContinuationArrangement({activity, sourceRequestId: "request-1", sourceResponseId: "response-1",
  sequence: 1, cause: {kind: "protocol_correction", code: "invalid", feedback: {text: "Return the declared response."}}});

function setup() {
  const values = new Map<string, unknown>();
  const port: ActivityCheckpointPort = {
    read: key => structuredClone(values.get(key) ?? null),
    commit: async (key, value) => { values.set(key, structuredClone(value)); },
    compareAndCommit: vi.fn(async (expected, writes) => {
      for (const entry of expected) expect(values.get(entry.key) ?? null).toEqual(entry.value);
      for (const entry of writes) values.set(entry.key, structuredClone(entry.value));
    }),
  };
  const input = {arrangement: arrangement(), expectedActivity: activity, maximumContinuations: 2,
    signal: new AbortController().signal, assertAvailable: vi.fn()};
  return {port, input, values, coordinator: new ActivityContinuationCoordinator(port)};
}

describe("Activity continuation acceptance", () => {
  it("recovers one acceptance without repeating feedback or resetting its sequence", async () => {
    const {coordinator, input, port, values} = setup();
    await coordinator.accept(input);
    expect(await new ActivityContinuationCoordinator(port).accept(input)).toEqual(input.arrangement);
    expect(port.compareAndCommit).toHaveBeenCalledTimes(1);
    expect(values.size).toBe(1);
    expect(input.assertAvailable).toHaveBeenCalledTimes(2);
  });

  it("rejects different content for an already accepted stage", async () => {
    const {coordinator, input} = setup();
    await coordinator.accept(input);
    await expect(coordinator.accept({...input, arrangement: createActivityContinuationArrangement({...arrangement(),
      cause: {kind: "protocol_correction", code: "changed", feedback: {text: "Different feedback"}}})})).rejects.toMatchObject({name: "ActivityCheckpointError"});
  });

  it("distinguishes local preparation and later remote rejection without resetting either source stage", async () => {
    const {coordinator, input, port, values} = setup();
    const local = createActivityContinuationArrangement({...arrangement(), sourceResponseId: null,
      cause: {kind: "capacity_rejection", location: "local_admission", code: "model_context_capacity_exceeded"}});
    const remote = createActivityContinuationArrangement({...local, sourceRequestId: "reprepared-request",
      cause: {kind: "capacity_rejection", location: "provider", code: "provider_context_window_exceeded"}});
    await coordinator.accept({...input, arrangement: local, maximumContinuations: 1});
    await coordinator.accept({...input, arrangement: remote, maximumContinuations: 1});
    await new ActivityContinuationCoordinator(port).accept({...input, arrangement: remote, maximumContinuations: 1});
    expect(values.size).toBe(2);
    expect(port.compareAndCommit).toHaveBeenCalledTimes(2);
    await expect(coordinator.accept({...input, arrangement: createActivityContinuationArrangement({...remote, sequence: 2}),
      maximumContinuations: 1})).rejects.toThrow();
  });

  it("does not accept another Run's activity, exhausted allowance or cancellation", async () => {
    const {coordinator, input, port} = setup();
    const child = createModelActivityBinding({...activity, runId: "child"});
    await expect(coordinator.accept({...input, expectedActivity: child})).rejects.toThrow();
    await expect(coordinator.accept({...input, maximumContinuations: 0})).rejects.toThrow();
    await expect(coordinator.accept({...input, signal: AbortSignal.abort(new Error("cancelled"))})).rejects.toThrow("cancelled");
    expect(port.compareAndCommit).not.toHaveBeenCalled();
  });

  it("keeps auxiliary input responsibility with its actual activity", async () => {
    const {coordinator, input} = setup();
    const auxiliary = createModelActivityBinding({runId: "root", activityId: "generation-1", purpose: "summary",
      owner: {kind: "context_generation", inputOwner: "activity"}});
    const continuation = createActivityContinuationArrangement({...arrangement(), activity: auxiliary,
      cause: {kind: "capacity_rejection", location: "provider", code: "provider_context_window_exceeded"}});
    const accepted = await coordinator.accept({...input, arrangement: continuation, expectedActivity: auxiliary});
    expect(accepted.activity.owner.inputOwner).toBe("activity");
    expect(() => createModelActivityBinding({...auxiliary, owner: {kind: "context_generation", inputOwner: "context_representation"} as never})).toThrow();
  });
});

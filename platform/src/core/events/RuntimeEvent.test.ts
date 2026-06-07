import { describe, expect, it } from "vitest";
import { RuntimeEventEmitter } from "./RuntimeEventEmitter.js";
import { RuntimeEventRecorder } from "./RuntimeEventRecorder.js";

describe("RuntimeEventEmitter", () => {
  it("emits ordered runtime events", () => {
    const emitter = new RuntimeEventEmitter();
    const recorder = new RuntimeEventRecorder();
    recorder.attachTo(emitter);

    emitter.emit({
      name: "task.started",
      taskId: "task_001",
      timestamp: "2026-06-07T00:00:00.000Z",
    });
    emitter.emit({
      name: "tool.started",
      taskId: "task_001",
      payload: {
        toolName: "net.lookupDns",
      },
      timestamp: "2026-06-07T00:00:01.000Z",
    });

    expect(recorder.names()).toEqual(["task.started", "tool.started"]);
    expect(recorder.events()).toMatchObject([
      {
        id: "runtime_event_1",
        sequence: 1,
      },
      {
        id: "runtime_event_2",
        sequence: 2,
        payload: {
          toolName: "net.lookupDns",
        },
      },
    ]);
  });

  it("supports unsubscribe", () => {
    const emitter = new RuntimeEventEmitter();
    const recorder = new RuntimeEventRecorder();
    const unsubscribe = recorder.attachTo(emitter);

    emitter.emit({
      name: "task.started",
      taskId: "task_001",
    });
    unsubscribe();
    emitter.emit({
      name: "task.completed",
      taskId: "task_001",
    });

    expect(recorder.names()).toEqual(["task.started"]);
  });
});

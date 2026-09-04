import { describe, expect, it } from "vitest";

import { createRunLifecycleHookComposition } from "./RunLifecycleHook.js";

describe("RunLifecycleHook composition", () => {
  it("snapshots hook metadata without freezing the externally owned handler", async () => {
    const calls: string[] = [];
    const handler = {
      async handle() {
        calls.push("handled");
        return { kind: "allow" as const };
      },
    };
    const handlerRef = Object.freeze({ id: "test.stop-handler", revision: "1" });

    const composition = createRunLifecycleHookComposition({
      id: "test.lifecycle-hooks",
      revision: "1",
      registrations: [Object.freeze({
        ref: Object.freeze({ id: "test.stop-hook", revision: "1" }),
        owner: Object.freeze({
          owner: "test",
          kind: "stop_hook",
          id: "test.stop-hook",
          revision: "1",
          run: null,
        }),
        event: "Stop" as const,
        runKinds: Object.freeze(["root" as const]),
        handler: handlerRef,
        timeoutMs: 5_000,
        maximumResultBytes: 8_192,
      })],
      bindings: [Object.freeze({
        ref: handlerRef,
        event: "Stop" as const,
        handler,
      })],
    });

    await handler.handle();

    expect(calls).toEqual(["handled"]);
    expect(Object.isFrozen(composition)).toBe(true);
    expect(Object.isFrozen(composition.set)).toBe(true);
    expect(Object.isFrozen(composition.bindings[0]?.handler)).toBe(false);
  });
});

import type {
  RuntimeEvent as RootRuntimeEvent,
} from "@agent-anything/agent-core";
import { describe, expect, expectTypeOf, it } from "vitest";
import { RuntimeEventEmitter } from "./events/index.js";
import * as coreApi from "./index.js";

describe("Agent Core public entry points", () => {
  it("keeps the transitional root as a RuntimeEvent-only type surface", () => {
    expect(Object.keys(coreApi)).toEqual([]);
    expectTypeOf<RootRuntimeEvent>().toMatchTypeOf<{ readonly name: string }>();
  });

  it("exposes only RuntimeEvent semantics awaiting migration", () => {
    expectTypeOf<RootRuntimeEvent>().toBeObject();
    expect(RuntimeEventEmitter).toBeTypeOf("function");
  });
});

import type {
  RuntimeEvent as RootRuntimeEvent,
} from "@agent-anything/agent-core";
import type {
  ContextProjection,
  Observation,
} from "@agent-anything/agent-core/context";
import { describe, expect, expectTypeOf, it } from "vitest";
import { applyContextUpdate } from "./context/index.js";
import { RuntimeEventEmitter } from "./events/index.js";
import * as coreApi from "./index.js";

describe("Agent Core public entry points", () => {
  it("keeps the transitional root as a RuntimeEvent-only type surface", () => {
    expect(Object.keys(coreApi)).toEqual([]);
    expectTypeOf<RootRuntimeEvent>().toMatchTypeOf<{ readonly name: string }>();
  });

  it("exposes only the Context and RuntimeEvent subpaths awaiting migration", () => {
    expectTypeOf<ContextProjection>().toBeObject();
    expectTypeOf<Observation>().toBeObject();
    expectTypeOf<RootRuntimeEvent>().toBeObject();
    expect(applyContextUpdate).toBeTypeOf("function");
    expect(RuntimeEventEmitter).toBeTypeOf("function");
  });
});

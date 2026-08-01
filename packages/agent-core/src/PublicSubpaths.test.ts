import type {
  Controller as RootController,
  RunResult as RootRunResult,
  RuntimeEvent as RootRuntimeEvent,
} from "@agent-anything/agent-core";
import type { Agent, AgentInstructions } from "@agent-anything/foundation/agent";
import type { Action } from "@agent-anything/foundation/action";
import type { RunInput } from "@agent-anything/foundation/run";
import type { AgentTask } from "@agent-anything/foundation/task";
import type {
  Controller,
  ControllerInput,
} from "@agent-anything/agent-core/controller";
import type { ContextProjection } from "@agent-anything/agent-core/context";
import type { Plan } from "@agent-anything/agent-core/plan";
import type { RetryPolicy } from "@agent-anything/agent-core/retry";
import type { RunResult } from "@agent-anything/agent-core/run";
import { describe, expect, expectTypeOf, it } from "vitest";
import { applyContextUpdate } from "./context/index.js";
import { RuntimeEventEmitter } from "./events/index.js";
import * as coreApi from "./index.js";
import { applyPlanUpdate } from "./plan/index.js";
import { snapshotRetryPolicy } from "./retry/index.js";
import { createRunCancellationController } from "./run/index.js";

describe("Agent Core public entry points", () => {
  it("keeps the root as an exact type-only composition surface", () => {
    expect(Object.keys(coreApi)).toEqual([]);
    expectTypeOf<RootController>().toEqualTypeOf<Controller>();
    expectTypeOf<RootRunResult>().toEqualTypeOf<RunResult>();
    expectTypeOf<RootRuntimeEvent>().toMatchTypeOf<{ readonly name: string }>();
  });

  it("resolves every specialized semantic subpath through package exports", () => {
    expectTypeOf<AgentInstructions>().toBeString();
    expectTypeOf<Agent>().toBeObject();
    expectTypeOf<AgentTask>().toBeObject();
    expectTypeOf<RunInput>().toBeObject();
    expectTypeOf<ControllerInput>().toBeObject();
    expectTypeOf<Action>().toBeObject();
    expectTypeOf<ContextProjection>().toBeObject();
    expectTypeOf<Plan>().toBeObject();
    expectTypeOf<RetryPolicy<string>>().toBeObject();
    expectTypeOf<RootRuntimeEvent>().toBeObject();
    expect(applyContextUpdate).toBeTypeOf("function");
    expect(applyPlanUpdate).toBeTypeOf("function");
    expect(snapshotRetryPolicy).toBeTypeOf("function");
    expect(createRunCancellationController).toBeTypeOf("function");
    expect(RuntimeEventEmitter).toBeTypeOf("function");
  });
});

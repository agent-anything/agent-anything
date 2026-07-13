import type { Agent } from "../agent/index.js";
import type { RunConfig } from "./RunConfig.js";
import type { RunInput } from "./RunInput.js";
import type { RunResult } from "./RunResult.js";

export interface Runner {
  run<TOutput>(
    agent: Agent<TOutput>,
    input: RunInput,
    config: RunConfig,
  ): Promise<RunResult<TOutput>>;
}

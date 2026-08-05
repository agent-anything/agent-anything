import {
  createRetryAttemptInterruptionFactory,
  createRetryWait,
  defaultRetryIdGenerator,
  systemRetryClock,
  systemRetryRandomSource,
} from "./RetryDependencies.js";
import type { RetryClock } from "./RetryExecution.js";
import { RetryExecutor } from "./RetryExecutor.js";

export function createSystemRetryExecutor(
  clock: RetryClock = systemRetryClock,
): RetryExecutor {
  return new RetryExecutor({
    clock,
    ids: defaultRetryIdGenerator,
    random: systemRetryRandomSource,
    wait: createRetryWait(clock),
    interruptions: createRetryAttemptInterruptionFactory(clock),
  });
}

import {onTestFinished} from "vitest";
import {ExecutionFixtureScope} from "./ExecutionFixtureScope.js";

/** Must run in an isolated fork: noncooperative teardown fails that process. */
export function withExecutionScope<A extends unknown[]>(body: (...args: A) => Promise<void>, cleanupMs = 15_000): (...args: A) => Promise<void> {
  return (...args) => {
    const scope = new ExecutionFixtureScope();
    onTestFinished(() => closeExecutionScope(scope, cleanupMs), 0);
    return scope.run(() => body(...args));
  };
}

/** The owned watchdog, not a racing hook timeout, gates the next test. */
export async function closeExecutionScope(scope: ExecutionFixtureScope, cleanupMs = 15_000): Promise<void> {
  const watchdog = setTimeout(() => {
    try {process.stderr.write(`Execution fixture cleanup exceeded ${cleanupMs} ms; terminating its isolated test process.\n`);}
    finally {
      // Vitest replaces process.exit with a throw. Kill only this owned fork.
      process.kill(process.pid, "SIGKILL");
    }
  }, cleanupMs);
  try {await scope.close();} finally {clearTimeout(watchdog);}
}

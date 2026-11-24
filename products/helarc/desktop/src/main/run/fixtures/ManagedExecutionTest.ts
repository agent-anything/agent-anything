import {onTestFinished} from "vitest";
import {writeSync} from "node:fs";
import {ExecutionFixtureScope} from "./ExecutionFixtureScope.js";
import {startExecutionTestCpuProfile} from "./ExecutionTestCpuProfile.js";
import {RunTreeCommitWriter,type RunTreeCommitDraft,type PreparedRunTreeTransition} from "@agent-anything/agent-runtime/execution-coordinator";
import {createExecutionCommitIdentityProbe} from "../../execution-storage/fixtures/ExecutionCommitIdentityProbe.js";

/** Must run in an isolated fork: noncooperative teardown fails that process. */
export function withExecutionScope<A extends unknown[]>(body: (...args: A) => Promise<void>, cleanupMs = 15_000): (...args: A) => Promise<void> {
  return (...args) => {
    const scope = new ExecutionFixtureScope();
    let stopProfile:(()=>Promise<void>)|null=null;
    const stopIdentities=process.env.HELARC_TEST_SNAPSHOT_IDENTITIES==="1"?observeCommitIdentities():null;
    onTestFinished(async result => {
      try {if(result.state==="fail")console.error("Execution fixture failure snapshot",JSON.stringify(scope.snapshot()));}
      finally {
        try {await closeExecutionScope(scope, cleanupMs);}
        finally {stopIdentities?.();await stopProfile?.();}
      }
    }, 0);
    return scope.run(async () => {stopProfile=await startExecutionTestCpuProfile();return body(...args);});
  };
}

function observeCommitIdentities():()=>void {
  const original=RunTreeCommitWriter.prototype.transaction,probe=createExecutionCommitIdentityProbe();
  RunTreeCommitWriter.prototype.transaction=function<T>(prepare:(draft:RunTreeCommitDraft)=>PreparedRunTreeTransition<T>,accepted?:()=>void):Promise<T> {
    return original.call(this,draft=>{const result=prepare(draft);probe.observeRuns(result.runs);return result;},accepted) as Promise<T>;
  };
  return ()=>{RunTreeCommitWriter.prototype.transaction=original;console.info("Run snapshot identity summary",JSON.stringify(probe.summary()));};
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
  try {await scope.close();}
  catch(error) {
    try {writeSync(2, `Execution fixture cleanup failed: ${String(error)}; terminating its isolated test process.\n`);}
    finally {process.kill(process.pid,"SIGKILL");}
    throw error;
  } finally {clearTimeout(watchdog);}
}

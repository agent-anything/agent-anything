import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function inspectTestExecutionPolicy() {
  return process.platform === "win32" ? invoke("inspect") : { platform: process.platform };
}

export function acquireForegroundTestPolicy({ report = (message, evidence) => console.info(message, JSON.stringify(evidence)) } = {}) {
  if (process.platform !== "win32") throw new Error("This explicit test profile requires Windows.");
  const observed = inspectTestExecutionPolicy();
  const restore = () => {
    const restored = invoke("restore", observed.after);
    if (!samePolicy(restored.after, observed.after)) throw new Error("test_execution_policy_restore_failed");
    report("Test execution policy restored", restored);
  };
  try {
    const selected = invoke("foreground");
    if (!samePolicy(selected.after, { Version: 1,
      ControlMask: observed.after.ControlMask | 1, StateMask: observed.after.StateMask & ~1 })) {
      throw new Error("test_execution_policy_selection_failed");
    }
    report("Test execution policy selected", selected);
    return restore;
  } catch (error) {
    try { restore(); } catch (cleanup) { throw new AggregateError([error, cleanup], "test_execution_policy_failed"); }
    throw error;
  }
}

function samePolicy(actual, expected) {
  return actual.Version === expected.Version && actual.ControlMask === expected.ControlMask && actual.StateMask === expected.StateMask;
}

function invoke(action, original) {
  const read = spawnSync("powershell.exe", ["-NoProfile", "-File",
    fileURLToPath(new URL("./test-process-execution-policy.ps1", import.meta.url)),
    "-TargetProcessId", String(process.pid), "-Action", action,
    ...(original ? ["-ControlMask", String(original.ControlMask), "-StateMask", String(original.StateMask)] : []),
  ], { windowsHide: true, encoding: "utf8", timeout: 10000 });
  if (read.error || read.status !== 0) throw new Error(`test_execution_policy_${action}_failed: ${read.error?.message ?? read.stderr}`);
  return JSON.parse(read.stdout);
}

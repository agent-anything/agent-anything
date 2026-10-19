import {afterEach, describe, expect, it} from "vitest";
import {mkdtemp, mkdir, rm, rmdir} from "node:fs/promises";
import {join, resolve, dirname, basename, delimiter} from "node:path";
import {tmpdir} from "node:os";
import {createCommandEnvironmentPolicy, selectNativeShell} from "./CommandActionIdentity.js";
import {captureCommandEnvironmentRecovery, restoreCommandEnvironmentRecovery} from "./CommandEnvironmentRecovery.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("command-env-test-")) throw new Error("Unexpected test path");
    await rm(root, {recursive: true, force: true});
  }
});

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "command-env-test-")); roots.push(cwd);
  const tools = join(cwd, "tools"); await mkdir(tools);
  const platform = process.platform === "win32" ? "win32" as const : "posix" as const;
  const key = Object.keys(process.env).find(key => key.toUpperCase() === "PATH") ?? "PATH";
  const environment = await createCommandEnvironmentPolicy({id: "test-environment", overrides: {[key]: `${tools}${delimiter}${process.env[key] ?? ""}`, RETAINED_TEST_VALUE: "original"}});
  const shell = await selectNativeShell({platform, cwd, environment: environment.environment});
  const snapshot = await captureCommandEnvironmentRecovery({environment, shell, cwd, platform});
  return {cwd, platform, tools, snapshot, policyId: environment.id};
}

describe("command environment recovery", () => {
  it("restores the complete original environment without merging newly inherited values", async () => {
    const value = await fixture();
    process.env.ADDED_AFTER_ADMISSION = "must-not-leak";
    try {
      const restored = await restoreCommandEnvironmentRecovery(value);
      expect(restored.environment).toEqual(value.snapshot.environment);
      expect(restored.environment.ADDED_AFTER_ADMISSION).toBeUndefined();
      expect(restored.digest).toBe(value.snapshot.digest);
    } finally { delete process.env.ADDED_AFTER_ADMISSION; }
  });
  it("rejects corrupt snapshots and unavailable path dependencies instead of using the new Host environment", async () => {
    const value = await fixture();
    await expect(restoreCommandEnvironmentRecovery({...value, snapshot: {...value.snapshot, digest: "invalid"}})).rejects.toThrow("digest_mismatch");
    await rmdir(value.tools);
    await expect(restoreCommandEnvironmentRecovery(value)).rejects.toThrow("command_path_dependency_changed");
  });
  it("rejects a changed selected Shell identity", async () => {
    const value = await fixture();
    await expect(restoreCommandEnvironmentRecovery({...value, snapshot: {...value.snapshot, shell: {...value.snapshot.shell,
      executable: {...value.snapshot.shell.executable, canonicalPath: join(value.cwd, "different")}}}})).rejects.toThrow("command_shell_dependency_changed");
  });
});

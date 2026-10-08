import { expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { HelarcPersistenceDiagnostics, persistenceFailureCode } from "./HelarcPersistenceDiagnostics.js";

it("retains a bounded safe failure history independently from Thread storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "helarc-persistence-diagnostics-"));
  const path = join(root, "diagnostics.json");
  try {
    const diagnostics = new HelarcPersistenceDiagnostics(path);
    for (let i = 0; i < 102; i++) await diagnostics.record({ operation: "run_projection", threadId: "thread", runId: "run",
      projectionSequence: i, expectedRevision: 1, occurredAt: new Date().toISOString(), code: "EIO" });
    const records = JSON.parse(await readFile(path, "utf8"));
    expect(records).toHaveLength(100);
    expect(records[0].projectionSequence).toBe(2);
    expect(persistenceFailureCode({ code: "private-secret", message: "private-path" })).toBe("persistence_write_failed");
    expect(persistenceFailureCode({ code: "ENOSPC" })).toBe("ENOSPC");
  } finally {
    if (!relative(tmpdir(), resolve(root)).startsWith("helarc-persistence-diagnostics-")) throw new Error("Unsafe test cleanup");
    await rm(root, { recursive: true, force: true });
  }
});

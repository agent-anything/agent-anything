import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { expect, it } from "vitest";
import { HelarcInspection } from "./HelarcInspection.js";

it("persists independent capture settings and opens a new recording on source restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "helarc-inspection-"));
  const path = join(root, "settings.json");
  const source = await HelarcInspection.create(path, join(root, "inspection"));
  try {
    expect(source.snapshot().settings).toEqual({ enabled: true, definition: true, agent: false, provider: false, execution: false });
    expect(source.snapshot().health.available).toBe(true);
    await source.save({ ...source.snapshot().settings, provider: true });
    await source.close();
    const reopened = await HelarcInspection.create(path, join(root, "inspection"));
    try {
      expect(reopened.snapshot().settings.provider).toBe(true);
      expect(reopened.recorder?.source.sourceId).toBe(source.recorder?.source.sourceId);
      expect(reopened.recorder?.manifest.datasetId).not.toBe(source.recorder?.manifest.datasetId);
    } finally { await reopened.close(); }
  } finally {
    await source.close();
    if (!relative(tmpdir(), root).startsWith("helarc-inspection-")) throw new Error("Invalid test cleanup target");
    await rm(root, { recursive: true });
  }
});

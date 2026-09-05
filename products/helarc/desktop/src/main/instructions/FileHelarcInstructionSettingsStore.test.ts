import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultHelarcInstructionSettings } from "@agent-anything/helarc/configuration";
import { FileHelarcInstructionSettingsStore } from "./FileHelarcInstructionSettingsStore.js";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function storePath() {
  const directory = await mkdtemp(join(tmpdir(), "helarc-instruction-settings-"));
  directories.push(directory);
  return join(directory, "instruction-settings.json");
}

describe("Instruction settings storage", () => {
  it("loads defaults only for an absent file and preserves edited disabled content after restart", async () => {
    const path = await storePath();
    const store = new FileHelarcInstructionSettingsStore(path);
    const defaults = createDefaultHelarcInstructionSettings();
    expect(await store.load()).toEqual(defaults);
    const settings = {
      ...defaults,
      agent: defaults.agent.map((section) => ({ ...section, enabled: false, content: "Saved draft." })),
      stop: defaults.stop.map((section) => ({ ...section, enabled: false, content: "Saved Stop text." })),
    };
    await store.save(settings);
    expect(await new FileHelarcInstructionSettingsStore(path).load()).toEqual(settings);
    expect(JSON.parse(await readFile(path, "utf8")).formatVersion).toBe(2);
  });

  it("rejects invalid data instead of quietly resetting it", async () => {
    const path = await storePath();
    const store = new FileHelarcInstructionSettingsStore(path);
    await store.save(createDefaultHelarcInstructionSettings());
    const before = await readFile(path, "utf8");
    await expect(store.save({ agent: [] })).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(before);
    await writeFile(path, JSON.stringify({ formatVersion: 99, settings: {} }));
    await expect(store.load()).rejects.toThrow(/version or shape/);
    await writeFile(path, JSON.stringify({ formatVersion: 1, settings: createDefaultHelarcInstructionSettings() }));
    await expect(store.load()).rejects.toThrow(/version or shape/);
  });

  it("keeps the committed settings when an atomic replacement fails", async () => {
    const path = await storePath();
    const store = new FileHelarcInstructionSettingsStore(path);
    const defaults = createDefaultHelarcInstructionSettings();
    await store.save(defaults);
    const failing = new FileHelarcInstructionSettingsStore(path, { operations: { replace: async () => { throw new Error("disk failure"); } } });
    await expect(failing.save({ ...defaults, protocol: defaults.protocol.map((entry) => ({ ...entry, enabled: false })) })).rejects.toThrow("disk failure");
    expect(await store.load()).toEqual(defaults);
  });
});

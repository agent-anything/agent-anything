import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { FileHelarcProjectStore } from "./FileHelarcProjectStore.js";

describe("FileHelarcProjectStore", () => {
  it("persists folder selection and serializes revision-checked edits", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "helarc-project-")), "projects.json");
    const store = new FileHelarcProjectStore(path);
    expect(await store.listProjects()).toEqual([]);
    const [project] = await store.save({ id: null, expectedRevision: null, name: "Example", primaryProfileId: "a", additionalProfileIds: ["b"] });
    expect((await new FileHelarcProjectStore(path).listProjects())[0]).toEqual(project);
    const input = { id: project!.id, expectedRevision: 1, name: "Renamed", primaryProfileId: "b", additionalProfileIds: ["a"] };
    const results = await Promise.allSettled([store.save(input), new FileHelarcProjectStore(path).save(input)]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(await store.listProjects()).toMatchObject([{ revision: 2, name: "Renamed", primaryProfileId: "b", additionalProfileIds: ["a"] }]);
    const contents = await readFile(path, "utf8");
    await expect(store.save({ ...input, expectedRevision: 2, additionalProfileIds: ["b"] })).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(contents);
  });

  it("rejects corrupt data without silently replacing it", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "helarc-project-")), "projects.json");
    await writeFile(path, '{"formatVersion":0,"projects":[]}');
    await expect(new FileHelarcProjectStore(path).listProjects()).rejects.toThrow("Project Store");
    expect(await readFile(path, "utf8")).toContain('"formatVersion":0');
  });
});

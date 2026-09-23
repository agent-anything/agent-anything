import { describe, expect, it } from "vitest";
import { snapshotHelarcProject } from "./HelarcProject.js";

const project = { id: "project", revision: 1, name: "Example", primaryProfileId: "primary", additionalProfileIds: ["additional"], createdAt: "2026-09-23T00:00:00.000Z", updatedAt: "2026-09-23T00:00:00.000Z" };
describe("Helarc Project", () => {
  it("owns a detached immutable folder selection without requiring Git", () => {
    const input = structuredClone(project);
    const snapshot = snapshotHelarcProject(input);
    input.additionalProfileIds.push("another");
    expect(snapshot.additionalProfileIds).toEqual(["additional"]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.additionalProfileIds)).toBe(true);
  });
  it.each([
    { ...project, additionalProfileIds: ["primary"] },
    { ...project, additionalProfileIds: ["a", "a"] },
    { ...project, primaryProfileId: "" },
    { ...project, revision: 0 },
    { ...project, name: "  " },
    { ...project, path: "D:/forged" },
    { ...project, updatedAt: "invalid" },
  ])("rejects malformed Project configuration", (value) => {
    expect(() => snapshotHelarcProject(value)).toThrow();
  });
});

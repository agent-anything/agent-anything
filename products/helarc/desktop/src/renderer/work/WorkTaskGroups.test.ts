import { describe, expect, it } from "vitest";
import type { TaskSummary } from "../../shared/HelarcWorkbench.js";
import { selectWorkTasks } from "./WorkTaskGroups.js";

function task(runId: string, status: string, parentRunId: string | null = "root", hasFinishedWork = false): TaskSummary {
  return { runId, parentRunId, status, hasFinishedWork, label: runId, objective: null, terminalCode: null, hasPlan: false };
}

describe("work task groups", () => {
  it("groups terminal tasks without treating waits, suspension or inactive work as finished", () => {
    const tasks = [task("root", "running", null), ...["completed", "failed", "cancelled", "running", "waiting", "suspended", "inactive"]
      .map(status => task(status, status))];
    expect([...selectWorkTasks(tasks, "current").members]).toEqual(["root", "running", "waiting", "suspended", "inactive"]);
    expect([...selectWorkTasks(tasks, "finished").members]).toEqual(["completed", "failed", "cancelled"]);
  });
  it("retains ancestors as context without changing their group membership", () => {
    const tasks = [task("root", "running", null), task("parent", "running"), task("child", "failed", "parent")];
    const finished = selectWorkTasks(tasks, "finished");
    expect(finished.tasks.map(t => t.runId)).toEqual(["root", "parent", "child"]);
    expect([...finished.members]).toEqual(["child"]);
    expect(finished.tasks[1]?.status).toBe("running");
    expect(selectWorkTasks(tasks, "current").tasks.map(t => t.runId)).toEqual(["root", "parent"]);
  });
  it("keeps earlier operations accessible while the same task continues", () => {
    const tasks = [task("root", "running", null), task("child", "running", "root", true)];
    expect(selectWorkTasks(tasks, "current").members.has("child")).toBe(true);
    expect(selectWorkTasks(tasks, "finished").members.has("child")).toBe(true);
    expect(tasks[1]?.status).toBe("running");
  });
});

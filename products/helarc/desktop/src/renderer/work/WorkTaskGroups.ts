import type { TaskSummary } from "../../shared/HelarcWorkbench.js";

export type WorkTaskGroup = "current" | "finished";

export function isFinishedTask(task: TaskSummary): boolean {
  return ["completed", "failed", "cancelled"].includes(task.status);
}

export function selectWorkTasks(tasks: readonly TaskSummary[], group: WorkTaskGroup) {
  const byId = new Map(tasks.map(task => [task.runId, task]));
  const members = new Set(tasks.filter(task => group === "current"
    ? !isFinishedTask(task) : isFinishedTask(task) || task.hasFinishedWork).map(task => task.runId));
  const included = new Set(members);
  for (const id of members) {
    const visited = new Set([id]);
    let parentId = byId.get(id)?.parentRunId;
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) break;
      included.add(parentId);
      parentId = parent.parentRunId;
    }
  }
  return { tasks: tasks.filter(task => included.has(task.runId)), members };
}

import type { AgentTask } from "../task/index.js";
import type { ContextManager } from "./ContextManager.js";
import type { ContextSnapshot } from "./ContextSnapshot.js";
import type { LegacyContextUpdate } from "./ContextUpdate.js";

export class InMemoryContextManager implements ContextManager {
  private readonly snapshots = new Map<string, ContextSnapshot>();

  async createInitial(task: AgentTask): Promise<ContextSnapshot> {
    const snapshot: ContextSnapshot = {
      taskId: task.id,
      messages: [],
      observations: [],
      evidenceRefs: [],
      metadata: {
        ...task.metadata,
        taskKind: task.kind,
        createdAt: task.createdAt,
      },
    };

    this.snapshots.set(task.id, cloneSnapshot(snapshot));

    return cloneSnapshot(snapshot);
  }

  async getSnapshot(taskId: string): Promise<ContextSnapshot> {
    const snapshot = this.snapshots.get(taskId);

    if (!snapshot) {
      throw new Error(`Context snapshot does not exist for task: ${taskId}`);
    }

    return cloneSnapshot(snapshot);
  }

  async applyUpdate(update: LegacyContextUpdate): Promise<ContextSnapshot> {
    const snapshot = this.snapshots.get(update.taskId);

    if (!snapshot) {
      throw new Error(`Context snapshot does not exist for task: ${update.taskId}`);
    }

    const updated: ContextSnapshot = {
      taskId: snapshot.taskId,
      messages: [
        ...snapshot.messages,
        ...(update.messages ?? []),
      ],
      observations: [
        ...snapshot.observations,
        ...(update.observations ?? []),
      ],
      evidenceRefs: appendUnique(
        snapshot.evidenceRefs,
        update.evidenceRefs ?? [],
      ),
      metadata: {
        ...snapshot.metadata,
        ...update.metadata,
      },
    };

    this.snapshots.set(update.taskId, cloneSnapshot(updated));

    return cloneSnapshot(updated);
  }
}

function appendUnique<TValue>(current: TValue[], next: TValue[]): TValue[] {
  const values = [...current];

  for (const value of next) {
    if (!values.includes(value)) {
      values.push(value);
    }
  }

  return values;
}

function cloneSnapshot(snapshot: ContextSnapshot): ContextSnapshot {
  if (typeof structuredClone === "function") {
    return structuredClone(snapshot);
  }

  return JSON.parse(JSON.stringify(snapshot)) as ContextSnapshot;
}

import {contextPreparationDigest, validateContextPreparationIntent, type ContextPreparationHead,
  type ContextPreparationStore, type ContextPreparationIntent} from "./ContextPreparation.js";

/** Non-durable host implementation; process recovery requires a durable owner. */
export class InMemoryContextPreparationStore implements ContextPreparationStore {
  private readonly heads = new Map<string, ContextPreparationHead>();
  private readonly stages = new Map<string, unknown>();
  async open(intent: ContextPreparationIntent): Promise<ContextPreparationHead> {
    validateContextPreparationIntent(intent);
    const prior = this.heads.get(intent.id);
    if (prior && contextPreparationDigest(prior.intent) !== contextPreparationDigest(intent)) throw new Error("context_preparation_conflict");
    const head = prior ?? {intent: structuredClone(intent), revision: 1, state: "open" as const, retirement: null};
    this.heads.set(intent.id, head);
    return structuredClone(head);
  }
  async read(id: string, stage: string): Promise<unknown | null> {
    this.validate(id, stage);
    return structuredClone(this.stages.get(JSON.stringify([id, stage])) ?? null);
  }
  async write(id: string, stage: string, value: unknown): Promise<void> {
    const head = this.validate(id, stage), key = JSON.stringify([id, stage]);
    if (value == null) throw new Error("context_preparation_invalid");
    if (this.stages.has(key)) {
      if (contextPreparationDigest(this.stages.get(key)) !== contextPreparationDigest(value)) throw new Error("context_preparation_stage_conflict");
      return;
    }
    if (head.state !== "open") throw new Error("context_preparation_retired");
    this.stages.set(key, structuredClone(value));
  }
  async retire(id: string, reason: string): Promise<void> {
    const head = this.heads.get(id);
    if (!head || !reason) throw new Error("context_preparation_missing");
    if (head.state === "retired") return;
    this.heads.set(id, {...head, revision: head.revision + 1, state: "retired", retirement: reason});
  }
  private validate(id: string, stage: string): ContextPreparationHead {
    const head = this.heads.get(id);
    if (!head || !head.intent.stages.includes(stage)) throw new Error("context_preparation_stage_not_admitted");
    return head;
  }
}

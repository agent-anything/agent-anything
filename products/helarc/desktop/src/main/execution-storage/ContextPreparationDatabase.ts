import type Database from "better-sqlite3";
import {contextPreparationDigest, validateContextPreparationIntent, type ContextPreparationHead,
  type ContextPreparationIntent} from "@agent-anything/context/preparation";
import type {ExecutionContentRoot} from "./ExecutionContent.js";

export const CONTEXT_PREPARATION_SCHEMA = `
CREATE TABLE context_preparations(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL, digest TEXT NOT NULL, value TEXT NOT NULL);
CREATE TABLE context_preparation_stages(id TEXT NOT NULL REFERENCES context_preparations(id), stage TEXT NOT NULL, digest TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(id,stage));
`;
export type ContextPreparationCommand =
  | {kind: "open"; intent: ContextPreparationIntent}
  | {kind: "read"; id: string; stage: string}
  | {kind: "write"; id: string; stage: string; value: unknown}
  | {kind: "retire"; id: string; reason: string};

/** Own transaction and immutable content roots; no Run revision is changed here. */
export class ContextPreparationDatabase {
  constructor(private readonly db: Database.Database,
    private readonly retain: (value: unknown) => ExecutionContentRoot,
    private readonly hydrate: (root: ExecutionContentRoot) => unknown) {}

  command(command: ContextPreparationCommand): {preparationValue: unknown} {
    return this.db.transaction(() => ({preparationValue: this.execute(command)}))();
  }

  private execute(command: ContextPreparationCommand): unknown {
    const id = command.kind === "open" ? command.intent.id : command.id;
    const head = this.head(id);
    if (command.kind === "open") {
      validateContextPreparationIntent(command.intent);
      if (head) {
        if (contextPreparationDigest(head.intent) !== contextPreparationDigest(command.intent)) fail("conflict");
        return head;
      }
      const value: ContextPreparationHead = {intent: command.intent, revision: 1, state: "open", retirement: null};
      const text = JSON.stringify(value);
      this.db.prepare("INSERT INTO context_preparations VALUES (?,?,?,?,?,?)").run(id, command.intent.runId, 1, "open", contextPreparationDigest(value), text);
      return value;
    }
    if (!head) fail("missing");
    if (command.kind === "retire") {
      if (!command.reason || command.reason.length > 2048) fail("invalid");
      if (head.state === "retired") return null;
      const value: ContextPreparationHead = {...head, state: "retired", revision: head.revision + 1, retirement: command.reason};
      const result = this.db.prepare("UPDATE context_preparations SET revision=?,state=?,digest=?,value=? WHERE id=? AND revision=? AND state='open'")
        .run(value.revision, value.state, contextPreparationDigest(value), JSON.stringify(value), id, head.revision);
      if (result.changes !== 1) fail("conflict");
      return null;
    }
    if (!head.intent.stages.includes(command.stage)) fail("stage_not_admitted");
    const row = this.db.prepare("SELECT digest,value FROM context_preparation_stages WHERE id=? AND stage=?").get(id, command.stage) as {digest:string;value:string} | undefined;
    let prior: unknown = null;
    if (row) {
      const root = JSON.parse(row.value) as ExecutionContentRoot;
      if (contextPreparationDigest(root) !== row.digest) fail("corrupt");
      prior = this.hydrate(root);
    }
    if (command.kind === "read") return prior;
    const root = this.retain(command.value);
    if (row) {
      if (contextPreparationDigest(root) !== row.digest) fail("stage_conflict");
      return null;
    }
    if (head.state !== "open") fail("retired");
    if (command.value === null || command.value === undefined) fail("invalid");
    this.db.prepare("INSERT INTO context_preparation_stages VALUES (?,?,?,?)").run(id, command.stage, contextPreparationDigest(root), JSON.stringify(root));
    return null;
  }

  private head(id: string): ContextPreparationHead | null {
    const row = this.db.prepare("SELECT run_id,revision,state,digest,value FROM context_preparations WHERE id=?").get(id) as
      {run_id:string; revision:number; state:string; digest:string; value:string} | undefined;
    if (!row) return null;
    const value = JSON.parse(row.value) as ContextPreparationHead;
    validateContextPreparationIntent(value.intent);
    if (contextPreparationDigest(value) !== row.digest || value.intent.id !== id || value.intent.runId !== row.run_id || value.revision !== row.revision ||
        value.state !== row.state || !["open", "retired"].includes(value.state)) fail("corrupt");
    return value;
  }
}
function fail(reason: string): never {throw new Error(`context_preparation_${reason}`);}

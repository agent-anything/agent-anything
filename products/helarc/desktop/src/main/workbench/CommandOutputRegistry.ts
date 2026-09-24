import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
  readRetainedProcessOutput,
  registerRetainedProcessOutput,
  RetainedProcessOutputError,
  type ProcessOutputPaths,
  type RetainedProcessOutputLocator,
} from "@agent-anything/helarc-local-environment/command";
import type {
  CommandOutputPage,
  CommandOutputQuery,
  WorkbenchScope,
} from "../../shared/HelarcWorkbench.js";

interface Entry {
  readonly scope: WorkbenchScope;
  readonly executionId: string;
  readonly locator: RetainedProcessOutputLocator;
}
export class CommandOutputRegistry {
  private tail: Promise<void> = Promise.resolve();
  private entries = new Map<string, Entry>();
  private loaded = false;
  constructor(private readonly path: string | null = null) {}

  register(
    scope: WorkbenchScope,
    executionId: string,
    storageRoot: string,
    paths: ProcessOutputPaths,
  ): Promise<void> {
    const work = this.tail.then(async () => {
      await this.load();
      const locator = await registerRetainedProcessOutput(
        executionId,
        storageRoot,
        paths,
      );
      const entry = { scope: { ...scope }, executionId, locator };
      const entries = new Map(this.entries);
      entries.set(key(scope, executionId), entry);
      if (this.path) {
        await mkdir(dirname(this.path), { recursive: true });
        const temporary = `${this.path}.${randomUUID()}.tmp`;
        try {
          const file = await open(temporary, "wx");
          try {
            await file.writeFile(
              JSON.stringify({ version: 1, entries: [...entries.values()] }),
            );
            await file.sync();
          } finally {
            await file.close();
          }
          await rename(temporary, this.path);
        } finally {
          await rm(temporary, { force: true }).catch(() => {});
        }
      }
      this.entries = entries;
    });
    this.tail = work.catch(() => {});
    return work;
  }

  async read(
    query: CommandOutputQuery,
    innerCursor: string | undefined,
  ): Promise<CommandOutputPage> {
    try {
      await this.tail;
      await this.load();
      const entry = this.entries.get(key(query, query.executionId));
      if (!entry) return { status: "unavailable", reason: "not_retained" };
      const result = await readRetainedProcessOutput(
        entry.locator,
        innerCursor,
      );
      return {
        status: "page",
        source: "retained",
        stdout: result.stdout,
        stderr: result.stderr,
        nextCursor: result.nextCursor,
        hasMore: result.hasMore,
        settled: true,
      };
    } catch (error) {
      return {
        status: "unavailable",
        reason:
          error instanceof RetainedProcessOutputError
            ? error.reason
            : "read_failed",
      };
    }
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    if (this.path) {
      try {
        const document = JSON.parse(await readFile(this.path, "utf8"));
        if (document.version !== 1 || !Array.isArray(document.entries))
          throw new Error("Command output locator document is invalid.");
        const entries = new Map<string, Entry>();
        for (const entry of document.entries as Entry[]) {
          if (
            !entry.scope?.threadId ||
            !entry.scope.productRunId ||
            !entry.scope.runId ||
            !entry.executionId ||
            entry.locator?.executionId !== entry.executionId
          )
            throw new Error("Command output locator is invalid.");
          const identity = key(entry.scope, entry.executionId);
          if (entries.has(identity))
            throw new Error("Duplicate command output locator.");
          entries.set(identity, entry);
        }
        this.entries = entries;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    this.loaded = true;
  }
}
function key(scope: WorkbenchScope, executionId: string): string {
  return JSON.stringify([
    scope.threadId,
    scope.productRunId,
    scope.runId,
    executionId,
  ]);
}

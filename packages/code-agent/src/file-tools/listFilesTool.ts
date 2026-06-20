import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { TaskWorkspaceScope } from "@agent-anything/agent-core";
import type { ToolDefinition } from "@agent-anything/tools";
import {
  CODE_AGENT_LIST_FILES_TOOL,
  type CodeAgentFileToolLimits,
  type ListFilesOutput,
  type WorkspaceFileEntry,
  type WorkspaceFileEntryKind,
} from "./FileToolContracts.js";
import { executeFileTool } from "./fileToolResult.js";
import { parseListFilesInput } from "./fileToolInput.js";
import {
  resolveExistingTarget,
  workspaceRelativePath,
} from "./filesystemBoundary.js";

export function createListFilesTool(input: {
  workspaceScope: TaskWorkspaceScope | undefined;
  limits: CodeAgentFileToolLimits;
  now: () => string;
}): ToolDefinition<unknown, ListFilesOutput> {
  return {
    name: CODE_AGENT_LIST_FILES_TOOL,
    description: "List files inside a declared task workspace root.",
    risk: "safe",
    metadata: {
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: {
          rootName: { type: "string" },
          path: { type: "string" },
          recursive: { type: "boolean" },
        },
      },
    },
    async execute(call) {
      return executeFileTool(call, input.now, async () => {
        const toolInput = parseListFilesInput(call.input);
        const target = await resolveExistingTarget({
          workspaceScope: input.workspaceScope,
          rootName: toolInput.rootName,
          path: toolInput.path,
          expectedKind: "directory",
        });
        const entries: WorkspaceFileEntry[] = [];
        const state = { truncated: false };

        await collectEntries(
          target.canonicalTarget,
          target.canonicalRoot,
          toolInput.recursive ?? false,
          input.limits.maxListEntries,
          entries,
          state,
        );

        return {
          rootName: target.resolved.rootName,
          workspaceId: target.resolved.workspaceId,
          path: target.resolved.relativePath,
          entries,
          truncated: state.truncated,
        };
      });
    },
  };
}

async function collectEntries(
  directory: string,
  canonicalRoot: string,
  recursive: boolean,
  maxEntries: number,
  output: WorkspaceFileEntry[],
  state: { truncated: boolean },
): Promise<void> {
  const directoryEntries = (await readdir(directory, {
    withFileTypes: true,
  })).sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of directoryEntries) {
    if (output.length >= maxEntries) {
      state.truncated = true;
      return;
    }

    const absolutePath = join(directory, entry.name);
    const kind = entryKind(entry);
    const stats = kind === "file" ? await lstat(absolutePath) : null;

    output.push({
      path: workspaceRelativePath(canonicalRoot, absolutePath),
      kind,
      sizeBytes: stats?.size ?? null,
    });

    if (recursive && kind === "directory") {
      await collectEntries(
        absolutePath,
        canonicalRoot,
        true,
        maxEntries,
        output,
        state,
      );
      if (state.truncated) {
        return;
      }
    }
  }
}

function entryKind(entry: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): WorkspaceFileEntryKind {
  if (entry.isFile()) {
    return "file";
  }
  if (entry.isDirectory()) {
    return "directory";
  }
  if (entry.isSymbolicLink()) {
    return "symbolicLink";
  }
  return "other";
}

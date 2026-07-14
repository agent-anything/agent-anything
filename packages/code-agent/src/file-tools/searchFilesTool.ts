import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { TaskWorkspaceScope } from "@agent-anything/agent-core";
import type {
  ToolDefinition,
  ToolInvocationContext,
} from "@agent-anything/tools";
import {
  CODE_AGENT_SEARCH_FILES_TOOL,
  type CodeAgentFileToolLimits,
  type FileSearchMatch,
  type SearchFilesOutput,
} from "./FileToolContracts.js";
import { parseSearchFilesInput } from "./fileToolInput.js";
import {
  executeFileTool,
  throwIfFileToolInterrupted,
} from "./fileToolResult.js";
import {
  resolveExistingTarget,
  workspaceRelativePath,
} from "./filesystemBoundary.js";
import { decodeUtf8 } from "./utf8.js";

export function createSearchFilesTool(input: {
  workspaceScope: TaskWorkspaceScope | undefined;
  limits: CodeAgentFileToolLimits;
  now: () => string;
}): ToolDefinition<unknown, SearchFilesOutput> {
  return {
    name: CODE_AGENT_SEARCH_FILES_TOOL,
    description: "Search UTF-8 files inside a declared task workspace root.",
    risk: "safe",
    metadata: {
      inputSchema: {
        type: "object",
        required: ["path", "query"],
        properties: {
          rootName: { type: "string" },
          path: { type: "string" },
          query: { type: "string" },
        },
      },
    },
    async execute(call, context) {
      return executeFileTool(call, input.now, context, async () => {
        throwIfFileToolInterrupted(context);
        const toolInput = parseSearchFilesInput(call.input);
        const target = await resolveExistingTarget({
          workspaceScope: input.workspaceScope,
          rootName: toolInput.rootName,
          path: toolInput.path,
          expectedKind: "fileOrDirectory",
        });
        throwIfFileToolInterrupted(context);
        const state: SearchState = {
          matches: [],
          truncated: false,
          skippedFiles: 0,
        };

        if (target.stats.isFile()) {
          await searchFile(
            target.canonicalTarget,
            target.canonicalRoot,
            toolInput.query,
            input.limits,
            state,
            context,
          );
        } else {
          await searchDirectory(
            target.canonicalTarget,
            target.canonicalRoot,
            toolInput.query,
            input.limits,
            state,
            context,
          );
        }

        return {
          rootName: target.resolved.rootName,
          workspaceId: target.resolved.workspaceId,
          path: target.resolved.relativePath,
          query: toolInput.query,
          matches: state.matches,
          truncated: state.truncated,
          skippedFiles: state.skippedFiles,
        };
      });
    },
  };
}

interface SearchState {
  matches: FileSearchMatch[];
  truncated: boolean;
  skippedFiles: number;
}

async function searchDirectory(
  directory: string,
  canonicalRoot: string,
  query: string,
  limits: CodeAgentFileToolLimits,
  state: SearchState,
  context: ToolInvocationContext,
): Promise<void> {
  const entries = (await readdir(directory, {
    withFileTypes: true,
  })).sort((left, right) => left.name.localeCompare(right.name));
  throwIfFileToolInterrupted(context);

  for (const entry of entries) {
    if (state.truncated) {
      return;
    }

    const absolutePath = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      await searchDirectory(
        absolutePath,
        canonicalRoot,
        query,
        limits,
        state,
        context,
      );
    } else if (entry.isFile()) {
      await searchFile(
        absolutePath,
        canonicalRoot,
        query,
        limits,
        state,
        context,
      );
    }
  }
}

async function searchFile(
  absolutePath: string,
  canonicalRoot: string,
  query: string,
  limits: CodeAgentFileToolLimits,
  state: SearchState,
  context: ToolInvocationContext,
): Promise<void> {
  const fileStats = await lstat(absolutePath);
  throwIfFileToolInterrupted(context);
  if (fileStats.size > limits.maxSearchFileBytes) {
    state.skippedFiles += 1;
    return;
  }

  const bytes = await readFile(absolutePath);
  throwIfFileToolInterrupted(context);
  if (
    bytes.byteLength > limits.maxSearchFileBytes ||
    bytes.includes(0)
  ) {
    state.skippedFiles += 1;
    return;
  }

  const decoded = decodeUtf8(bytes);
  if (decoded === null) {
    state.skippedFiles += 1;
    return;
  }

  const content = decoded.replaceAll(String.fromCharCode(13), "");
  const lines = content.split(String.fromCharCode(10));
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    throwIfFileToolInterrupted(context);
    const line = lines[lineIndex]!;
    let fromIndex = 0;

    while (fromIndex <= line.length) {
      const matchIndex = line.indexOf(query, fromIndex);
      if (matchIndex < 0) {
        break;
      }

      state.matches.push({
        path: workspaceRelativePath(canonicalRoot, absolutePath),
        line: lineIndex + 1,
        column: matchIndex + 1,
        preview: line.slice(0, 240),
      });

      if (state.matches.length >= limits.maxSearchMatches) {
        state.truncated = true;
        return;
      }

      fromIndex = matchIndex + query.length;
    }
  }
}

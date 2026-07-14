import { readFile } from "node:fs/promises";
import type { TaskWorkspaceScope } from "@agent-anything/agent-core";
import type { ToolDefinition } from "@agent-anything/tools";
import {
  CODE_AGENT_READ_FILE_TOOL,
  type CodeAgentFileToolLimits,
  type ReadFileOutput,
} from "./FileToolContracts.js";
import { FileToolError } from "./FileToolError.js";
import { parseWorkspaceFileInput } from "./fileToolInput.js";
import {
  executeFileTool,
  throwIfFileToolInterrupted,
} from "./fileToolResult.js";
import { resolveExistingTarget } from "./filesystemBoundary.js";
import { decodeUtf8 } from "./utf8.js";

export function createReadFileTool(input: {
  workspaceScope: TaskWorkspaceScope | undefined;
  limits: CodeAgentFileToolLimits;
  now: () => string;
}): ToolDefinition<unknown, ReadFileOutput> {
  return {
    name: CODE_AGENT_READ_FILE_TOOL,
    description: "Read a UTF-8 file inside a declared task workspace root.",
    risk: "safe",
    metadata: {
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: {
          rootName: { type: "string" },
          path: { type: "string" },
        },
      },
    },
    async execute(call, context) {
      return executeFileTool(call, input.now, context, async () => {
        throwIfFileToolInterrupted(context);
        const toolInput = parseWorkspaceFileInput(call.input);
        const target = await resolveExistingTarget({
          workspaceScope: input.workspaceScope,
          rootName: toolInput.rootName,
          path: toolInput.path,
          expectedKind: "file",
        });
        throwIfFileToolInterrupted(context);

        if (target.stats.size > input.limits.maxReadBytes) {
          throw new FileToolError(
            "file_read_limit_exceeded",
            "File exceeds the configured read byte limit.",
            {
              rootName: target.resolved.rootName,
              workspaceId: target.resolved.workspaceId,
              path: target.resolved.relativePath,
              sizeBytes: target.stats.size,
              maxReadBytes: input.limits.maxReadBytes,
            },
          );
        }

        const bytes = await readFile(target.canonicalTarget);
        throwIfFileToolInterrupted(context);
        if (bytes.byteLength > input.limits.maxReadBytes) {
          throw new FileToolError(
            "file_read_limit_exceeded",
            "File exceeds the configured read byte limit.",
            {
              rootName: target.resolved.rootName,
              workspaceId: target.resolved.workspaceId,
              path: target.resolved.relativePath,
              sizeBytes: bytes.byteLength,
              maxReadBytes: input.limits.maxReadBytes,
            },
          );
        }

        const content = decodeUtf8(bytes);
        if (content === null) {
          throw new FileToolError(
            "file_not_utf8",
            "File is not valid UTF-8 text.",
            {
              rootName: target.resolved.rootName,
              workspaceId: target.resolved.workspaceId,
              path: target.resolved.relativePath,
            },
          );
        }

        return {
          rootName: target.resolved.rootName,
          workspaceId: target.resolved.workspaceId,
          path: target.resolved.relativePath,
          content,
          sizeBytes: bytes.byteLength,
        };
      });
    },
  };
}

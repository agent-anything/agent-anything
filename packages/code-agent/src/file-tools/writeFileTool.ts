import { Buffer } from "node:buffer";
import { writeFile } from "node:fs/promises";
import type { TaskWorkspaceScope } from "@agent-anything/agent-core";
import type { ToolDefinition } from "@agent-anything/tools";
import {
  CODE_AGENT_WRITE_FILE_TOOL,
  type CodeAgentFileToolLimits,
  type WriteFileOutput,
} from "./FileToolContracts.js";
import { FileToolError } from "./FileToolError.js";
import { parseWriteFileInput } from "./fileToolInput.js";
import {
  executeFileTool,
  throwIfFileToolInterrupted,
} from "./fileToolResult.js";
import { resolveWritableTarget } from "./filesystemBoundary.js";

export function createWriteFileTool(input: {
  workspaceScope: TaskWorkspaceScope | undefined;
  limits: CodeAgentFileToolLimits;
  now: () => string;
}): ToolDefinition<unknown, WriteFileOutput> {
  return {
    name: CODE_AGENT_WRITE_FILE_TOOL,
    description: "Write a UTF-8 file inside a declared task workspace root.",
    risk: "risky",
    metadata: {
      inputSchema: {
        type: "object",
        required: ["path", "content"],
        properties: {
          rootName: { type: "string" },
          path: { type: "string" },
          content: { type: "string" },
          overwrite: { type: "boolean" },
        },
      },
    },
    async execute(call, context) {
      return executeFileTool(call, input.now, context, async () => {
        throwIfFileToolInterrupted(context);
        const toolInput = parseWriteFileInput(call.input);
        const bytesWritten = Buffer.byteLength(toolInput.content, "utf8");

        if (bytesWritten > input.limits.maxWriteBytes) {
          throw new FileToolError(
            "file_write_limit_exceeded",
            "Content exceeds the configured write byte limit.",
            {
              path: toolInput.path,
              sizeBytes: bytesWritten,
              maxWriteBytes: input.limits.maxWriteBytes,
            },
          );
        }

        const target = await resolveWritableTarget({
          workspaceScope: input.workspaceScope,
          rootName: toolInput.rootName,
          path: toolInput.path,
          overwrite: toolInput.overwrite ?? false,
        });
        throwIfFileToolInterrupted(context);

        try {
          await writeFile(target.canonicalTarget, toolInput.content, {
            encoding: "utf8",
            flag: target.created ? "wx" : "w",
          });
        } catch (error) {
          if (
            target.created &&
            error instanceof Error &&
            "code" in error &&
            (error as NodeJS.ErrnoException).code === "EEXIST"
          ) {
            throw new FileToolError(
              "file_already_exists",
              "File appeared before it could be created safely.",
              {
                rootName: target.resolved.rootName,
                workspaceId: target.resolved.workspaceId,
                path: target.resolved.relativePath,
              },
            );
          }
          throw error;
        }

        return {
          rootName: target.resolved.rootName,
          workspaceId: target.resolved.workspaceId,
          path: target.resolved.relativePath,
          bytesWritten,
          created: target.created,
          replaced: !target.created,
        };
      });
    },
  };
}

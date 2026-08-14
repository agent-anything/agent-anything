import { describe, expect, it } from "vitest";
import { resolveWorkspacePath } from "./workspace/index.js";
import {
  CODE_AGENT_READ_FILE_TOOL,
  createCodeFileOperationContribution,
} from "./file-operation/index.js";

describe("bounded Code Workspace public API", () => {
  it("exposes only source addressing and file Operation semantics", () => {
    expect(typeof resolveWorkspacePath).toBe("function");
    expect(CODE_AGENT_READ_FILE_TOOL).toBe("codeAgent.readFile");
    expect(createCodeFileOperationContribution({
      actionAdapterIds: {
        list: "helarc.local.filesystem.list.adapter",
        read: "helarc.local.filesystem.read.adapter",
        search: "helarc.local.filesystem.search.adapter",
        create: "helarc.local.filesystem.create.adapter",
        update: "helarc.local.filesystem.update.adapter",
        delete: "helarc.local.filesystem.delete.adapter",
      },
      admittedAt: "2026-08-13T00:00:00.000Z",
    }).operations).toHaveLength(6);
  });
});

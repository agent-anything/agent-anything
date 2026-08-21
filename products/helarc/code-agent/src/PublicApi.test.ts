import { describe, expect, it } from "vitest";
import { resolveWorkspacePath } from "./workspace/index.js";
import {
  CODE_AGENT_EDIT_TOOL,
  CODE_AGENT_GLOB_TOOL,
  CODE_AGENT_GREP_TOOL,
  CODE_AGENT_READ_TOOL,
  CODE_AGENT_WRITE_TOOL,
  createCodeFileOperationContribution,
} from "./file-operation/index.js";

describe("bounded Code Workspace public API", () => {
  it("exposes only source addressing and file Operation semantics", () => {
    expect(typeof resolveWorkspacePath).toBe("function");
    expect([
      CODE_AGENT_READ_TOOL,
      CODE_AGENT_GLOB_TOOL,
      CODE_AGENT_GREP_TOOL,
      CODE_AGENT_EDIT_TOOL,
      CODE_AGENT_WRITE_TOOL,
    ]).toEqual(["Read", "Glob", "Grep", "Edit", "Write"]);
    const contribution = createCodeFileOperationContribution({
      actionAdapterIds: {
        read: "helarc.local.filesystem.read.adapter",
        glob: "helarc.local.filesystem.glob.adapter",
        grep: "helarc.local.filesystem.grep.adapter",
        edit: "helarc.local.filesystem.edit.adapter",
        write: "helarc.local.filesystem.write.adapter",
      },
      admittedAt: "2026-08-13T00:00:00.000Z",
    });
    expect(contribution.operations).toHaveLength(5);
    expect(contribution.tools.map(({ descriptor }) => descriptor.name)).toEqual([
      "Read",
      "Glob",
      "Grep",
      "Edit",
      "Write",
    ]);
  });
});

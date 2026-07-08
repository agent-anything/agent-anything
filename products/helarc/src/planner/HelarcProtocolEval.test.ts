import { describe, expect, it } from "vitest";
import {
  type HelarcProtocolEvalFixture,
  runHelarcProtocolEvalFixture,
} from "./HelarcProtocolEval.js";

const READ_ONLY_TOOLS = [
  "codeAgent.listFiles",
  "codeAgent.readFile",
  "codeAgent.searchFiles",
];

const SHELL_ENABLED_TOOLS = [
  ...READ_ONLY_TOOLS,
  "codeAgent.runCommand",
];

const fixtures: HelarcProtocolEvalFixture[] = [
  {
    id: "create-file-through-propose",
    taskPrompt: "Create an empty file named empty.txt.",
    mode: "read-only",
    providerOutput: {
      action: "propose",
      summary: "Create empty.txt.",
      change: { operation: "create", path: "empty.txt", content: "" },
    },
    expectedExposedToolNames: READ_ONLY_TOOLS,
    expected: {
      kind: "planStep",
      action: "propose",
      planStepKind: "final",
      finalOutputKind: "propose",
      changeOperation: "create",
    },
  },
  {
    id: "read-known-file-through-tool",
    taskPrompt: "Read package.json.",
    mode: "read-only",
    providerOutput: {
      action: "call_tool",
      toolName: "codeAgent.readFile",
      input: { path: "package.json" },
    },
    expectedExposedToolNames: READ_ONLY_TOOLS,
    expected: {
      kind: "planStep",
      action: "call_tool",
      planStepKind: "callTool",
      toolName: "codeAgent.readFile",
    },
  },
  {
    id: "search-text-through-tool",
    taskPrompt: "Search for TODO.",
    mode: "read-only",
    providerOutput: {
      action: "call_tool",
      toolName: "codeAgent.searchFiles",
      input: { path: ".", query: "TODO" },
    },
    expectedExposedToolNames: READ_ONLY_TOOLS,
    expected: {
      kind: "planStep",
      action: "call_tool",
      planStepKind: "callTool",
      toolName: "codeAgent.searchFiles",
    },
  },
  {
    id: "list-files-through-tool",
    taskPrompt: "List files.",
    mode: "read-only",
    providerOutput: {
      action: "call_tool",
      toolName: "codeAgent.listFiles",
      input: { path: ".", recursive: false },
    },
    expectedExposedToolNames: READ_ONLY_TOOLS,
    expected: {
      kind: "planStep",
      action: "call_tool",
      planStepKind: "callTool",
      toolName: "codeAgent.listFiles",
    },
  },
  {
    id: "explain-only-completes",
    taskPrompt: "Explain this project.",
    mode: "read-only",
    providerOutput: {
      action: "complete",
      summary: "This project contains a Helarc code-agent product.",
    },
    expectedExposedToolNames: READ_ONLY_TOOLS,
    expected: {
      kind: "planStep",
      action: "complete",
      planStepKind: "final",
      finalOutputKind: "complete",
    },
  },
  {
    id: "shell-disabled-file-creation-uses-propose",
    taskPrompt: "Create an empty file named empty.txt.",
    mode: "read-only",
    providerOutput: {
      action: "propose",
      summary: "Create empty.txt without shell.",
      change: { operation: "create", path: "empty.txt", content: "" },
    },
    expectedExposedToolNames: READ_ONLY_TOOLS,
    expected: {
      kind: "planStep",
      action: "propose",
      planStepKind: "final",
      finalOutputKind: "propose",
      changeOperation: "create",
    },
  },
  {
    id: "shell-enabled-exposes-command-tool",
    taskPrompt: "Run npm test.",
    mode: "shell-enabled",
    providerOutput: {
      action: "call_tool",
      toolName: "codeAgent.runCommand",
      input: { command: "npm", args: ["test"], cwd: "." },
    },
    expectedExposedToolNames: SHELL_ENABLED_TOOLS,
    expected: {
      kind: "planStep",
      action: "call_tool",
      planStepKind: "callTool",
      toolName: "codeAgent.runCommand",
    },
  },
  {
    id: "invalid-tool-name-rejected",
    taskPrompt: "Write a file.",
    mode: "read-only",
    providerOutput: {
      action: "call_tool",
      toolName: "codeAgent.writeFile",
      input: { path: "empty.txt", content: "" },
    },
    expectedExposedToolNames: READ_ONLY_TOOLS,
    expected: {
      kind: "error",
      code: "planner_tool_name_unsupported",
    },
  },
  {
    id: "invalid-action-rejected",
    taskPrompt: "Rename a file.",
    mode: "read-only",
    providerOutput: {
      action: "rename_file",
      path: "old.txt",
      newPath: "new.txt",
    },
    expectedExposedToolNames: READ_ONLY_TOOLS,
    expected: {
      kind: "error",
      code: "planner_action_invalid",
    },
  },
  {
    id: "invalid-json-rejected",
    taskPrompt: "Read package.json.",
    mode: "read-only",
    providerOutput: "{",
    expectedExposedToolNames: READ_ONLY_TOOLS,
    expected: {
      kind: "error",
      code: "planner_output_not_json",
    },
  },
];

describe("Helarc protocol eval", () => {
  for (const fixture of fixtures) {
    it(`passes ${fixture.id}`, () => {
      const result = runHelarcProtocolEvalFixture(fixture);

      expect(result, result.failureMessage).toMatchObject({
        fixtureId: fixture.id,
        passed: true,
      });
    });
  }
});

import type { ToolAnnotations, ToolJsonObject } from "@agent-anything/tools/catalog";

export type HelarcShellToolName = "Bash" | "PowerShell";

export type HelarcShellRuntimeProfile =
  | {
      readonly toolName: "Bash";
      readonly executable: "bash";
      readonly dialect: "bash";
    }
  | {
      readonly toolName: "PowerShell";
      readonly executable: "pwsh";
      readonly dialect: "powershell-7";
    }
  | {
      readonly toolName: "PowerShell";
      readonly executable: "powershell";
      readonly dialect: "windows-powershell";
    };

export type HelarcBaselineToolName =
  | "Read"
  | "Glob"
  | "Grep"
  | "Edit"
  | "Write"
  | HelarcShellToolName
  | "TaskStop"
  | "AskUserQuestion"
  | "Agent"
  | "SendMessage";

export type HelarcToolSettlementBinding =
  | {
      readonly kind: "operation";
      readonly target: string;
      readonly canonicalEffect:
        | "file_system.read"
        | "file_system.write"
        | "process.spawn"
        | "process.signal";
    }
  | {
      readonly kind: "interaction";
      readonly target: "helarc.clarification";
      readonly canonicalEffect: null;
    }
  | {
      readonly kind: "descendant_run";
      readonly target: "agent.child";
      readonly canonicalEffect: null;
    }
  | {
      readonly kind: "descendant_message";
      readonly target: "agent.child";
      readonly canonicalEffect: null;
    };

export interface HelarcBaselineToolContract {
  readonly name: HelarcBaselineToolName;
  readonly description: string;
  readonly inputSchema: ToolJsonObject;
  readonly outputSchema: ToolJsonObject;
  readonly annotations: ToolAnnotations;
  readonly binding: HelarcToolSettlementBinding;
}

export const HELARC_BASELINE_TOOL_CONTRACT_REVISION =
  "helarc.baseline-tool-contracts.v2";

const POSITIVE_INTEGER = Object.freeze({
  type: "integer",
  minimum: 1,
}) satisfies ToolJsonObject;

const PATH = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: 4_096,
}) satisfies ToolJsonObject;

const BASELINE = objectSchema(
  ["target_id", "file_path", "byte_length", "content_digest"],
  {
    target_id: { type: "string", minLength: 1, maxLength: 1_024 },
    file_path: PATH,
    byte_length: { type: "integer", minimum: 0 },
    content_digest: { type: "string", minLength: 1, maxLength: 256 },
  },
);

const READ = contract({
  name: "Read",
  description: "Read bounded textual content from one exact Workspace file.",
  inputSchema: objectSchema(["file_path"], {
    file_path: PATH,
    offset: POSITIVE_INTEGER,
    limit: POSITIVE_INTEGER,
  }),
  outputSchema: objectSchema(
    [
      "target_id",
      "file_path",
      "content",
      "start_line",
      "end_line",
      "total_lines",
      "byte_length",
      "content_digest",
      "truncated",
    ],
    {
      target_id: { type: "string", minLength: 1, maxLength: 1_024 },
      file_path: PATH,
      content: { type: "string" },
      start_line: POSITIVE_INTEGER,
      end_line: { type: "integer", minimum: 0 },
      total_lines: { type: "integer", minimum: 0 },
      byte_length: { type: "integer", minimum: 0 },
      content_digest: { type: "string", minLength: 1, maxLength: 256 },
      truncated: { type: "boolean" },
    },
  ),
  annotations: { readOnlyHint: true },
  binding: operation("helarc.file.read", "file_system.read"),
});

const GLOB = contract({
  name: "Glob",
  description: "Find Workspace paths with one bounded glob pattern.",
  inputSchema: objectSchema(["pattern"], {
    pattern: { type: "string", minLength: 1, maxLength: 4_096 },
    path: PATH,
  }),
  outputSchema: objectSchema(["matches", "truncated", "omitted_count"], {
    matches: { type: "array", items: PATH },
    truncated: { type: "boolean" },
    omitted_count: { type: "integer", minimum: 0 },
  }),
  annotations: { readOnlyHint: true },
  binding: operation("helarc.path.glob", "file_system.read"),
});

const GREP = contract({
  name: "Grep",
  description: "Search Workspace text with one bounded regular expression.",
  inputSchema: objectSchema(["pattern"], {
    pattern: { type: "string", minLength: 1, maxLength: 4_096 },
    path: PATH,
    glob: { type: "string", minLength: 1, maxLength: 4_096 },
    output_mode: { enum: ["content", "files_with_matches", "count"] },
    case_sensitive: { type: "boolean" },
    before_context: { type: "integer", minimum: 0 },
    after_context: { type: "integer", minimum: 0 },
    offset: POSITIVE_INTEGER,
    limit: POSITIVE_INTEGER,
    multiline: { type: "boolean" },
  }),
  outputSchema: objectSchema(
    ["output_mode", "entries", "truncated", "omitted_count"],
    {
      output_mode: { enum: ["content", "files_with_matches", "count"] },
      entries: {
        type: "array",
        items: {
          oneOf: [
            objectSchema(["file_path"], { file_path: PATH }),
            objectSchema(["file_path", "count"], {
              file_path: PATH,
              count: { type: "integer", minimum: 0 },
            }),
            objectSchema(["file_path", "line", "column", "text", "before", "after"], {
              file_path: PATH,
              line: POSITIVE_INTEGER,
              column: POSITIVE_INTEGER,
              text: { type: "string" },
              before: { type: "array", items: { type: "string" } },
              after: { type: "array", items: { type: "string" } },
            }),
          ],
        },
      },
      truncated: { type: "boolean" },
      omitted_count: { type: "integer", minimum: 0 },
    },
  ),
  annotations: { readOnlyHint: true },
  binding: operation("helarc.content.grep", "file_system.read"),
});

const EDIT = contract({
  name: "Edit",
  description: "Replace exact text against one current file baseline.",
  inputSchema: objectSchema(["file_path", "old_string", "new_string"], {
    file_path: PATH,
    old_string: { type: "string", minLength: 1 },
    new_string: { type: "string" },
    replace_all: { type: "boolean" },
  }),
  outputSchema: objectSchema(
    [
      "target_id",
      "file_path",
      "operation",
      "replacement_count",
      "previous_baseline",
      "current_baseline",
    ],
    {
      target_id: { type: "string", minLength: 1, maxLength: 1_024 },
      file_path: PATH,
      operation: { const: "updated" },
      replacement_count: POSITIVE_INTEGER,
      previous_baseline: BASELINE,
      current_baseline: BASELINE,
    },
  ),
  annotations: { destructiveHint: true },
  binding: operation("helarc.file.edit", "file_system.write"),
});

const WRITE = contract({
  name: "Write",
  description: "Create or replace complete content for one exact Workspace file.",
  inputSchema: objectSchema(["file_path", "content"], {
    file_path: PATH,
    content: { type: "string" },
  }),
  outputSchema: objectSchema(
    ["target_id", "file_path", "operation", "previous_baseline", "current_baseline"],
    {
      target_id: { type: "string", minLength: 1, maxLength: 1_024 },
      file_path: PATH,
      operation: { enum: ["created", "replaced"] },
      previous_baseline: { anyOf: [BASELINE, { type: "null" }] },
      current_baseline: BASELINE,
    },
  ),
  annotations: { destructiveHint: true },
  binding: operation("helarc.file.write", "file_system.write"),
});

const TASK_STOP = contract({
  name: "TaskStop",
  description: "Stop one exact background command owned by the current Run.",
  inputSchema: objectSchema(["task_id"], {
    task_id: { type: "string", minLength: 1, maxLength: 1_024 },
  }),
  outputSchema: objectSchema(["task_id", "status", "signal", "effect_certainty"], {
    task_id: { type: "string", minLength: 1, maxLength: 1_024 },
    status: { enum: ["stopped", "completed"] },
    signal: { anyOf: [{ type: "string" }, { type: "null" }] },
    effect_certainty: { enum: ["known_applied", "known_not_applied", "unknown"] },
  }),
  annotations: { destructiveHint: true, idempotentHint: true },
  binding: operation("helarc.task.stop", "process.signal"),
});

const ASK_USER_QUESTION = contract({
  name: "AskUserQuestion",
  description: "Request bounded missing information or a user decision.",
  inputSchema: objectSchema(["questions"], {
    questions: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: objectSchema(["id", "prompt", "allow_multiple"], {
        id: { type: "string", minLength: 1, maxLength: 128 },
        prompt: { type: "string", minLength: 1, maxLength: 4_096 },
        options: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: objectSchema(["label", "description"], {
            label: { type: "string", minLength: 1, maxLength: 256 },
            description: { type: "string", minLength: 1, maxLength: 1_024 },
          }),
        },
        allow_multiple: { type: "boolean" },
      }),
    },
  }),
  outputSchema: objectSchema(["request_ref", "answers"], {
    request_ref: { type: "string", minLength: 1, maxLength: 1_024 },
    answers: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: objectSchema(["question_id", "selected_labels", "text"], {
        question_id: { type: "string", minLength: 1, maxLength: 128 },
        selected_labels: {
          type: "array",
          maxItems: 8,
          items: { type: "string", minLength: 1, maxLength: 256 },
        },
        text: { anyOf: [{ type: "string" }, { type: "null" }] },
      }),
    },
  }),
  annotations: {},
  binding: {
    kind: "interaction",
    target: "helarc.clarification",
    canonicalEffect: null,
  },
});

const DELEGATION_RESULT_REF = objectSchema(["kind", "id", "revision"], {
  kind: { const: "delegation_result" },
  id: { type: "string", minLength: 1, maxLength: 1_024 },
  revision: { type: "string", minLength: 1, maxLength: 256 },
});

const DELEGATION_RESULT_OUTPUT = objectSchema(["result_ref", "child_run_id", "status", "summary", "artifact_refs", "verification_status", "effect_status", "uncertainty", "failure_code"], {
  result_ref: DELEGATION_RESULT_REF,
  child_run_id: { type: "string", minLength: 1, maxLength: 1_024 },
  status: { enum: ["succeeded", "blocked", "failed", "cancelled"] },
  summary: { type: "string", maxLength: 64_000 },
  artifact_refs: {
    type: "array",
    items: { type: "string", minLength: 1, maxLength: 1_024 },
  },
  verification_status: { type: "string" },
  effect_status: { type: "string" },
  uncertainty: {
    type: "array",
    items: { type: "string", minLength: 1, maxLength: 256 },
  },
  failure_code: { anyOf: [{ type: "string" }, { type: "null" }] },
});

const AGENT = contract({
  name: "Agent",
  description: "Delegate one bounded objective to a new descendant Agent.",
  inputSchema: objectSchema(["prompt"], {
    prompt: { type: "string", minLength: 1, maxLength: 64_000 },
    description: { type: "string", minLength: 1, maxLength: 1_024 },
    dependency_result: DELEGATION_RESULT_REF,
    replaced_result: DELEGATION_RESULT_REF,
  }),
  outputSchema: DELEGATION_RESULT_OUTPUT,
  annotations: {},
  binding: {
    kind: "descendant_run",
    target: "agent.child",
    canonicalEffect: null,
  },
});

const SEND_MESSAGE = contract({
  name: "SendMessage",
  description: "Send one bounded instruction to one exact active descendant or continuation target.",
  inputSchema: objectSchema(["target", "message"], {
    target: objectSchema(["kind", "id"], {
      kind: { enum: ["active", "continuation"] },
      id: { type: "string", minLength: 1, maxLength: 1_024 },
    }),
    message: { type: "string", minLength: 1, maxLength: 64_000 },
  }),
  outputSchema: Object.freeze({
    oneOf: [
      objectSchema(["delivery", "child_run_id", "command_id"], {
        delivery: { const: "active" },
        child_run_id: { type: "string", minLength: 1, maxLength: 1_024 },
        command_id: { type: "string", minLength: 1, maxLength: 1_024 },
      }),
      DELEGATION_RESULT_OUTPUT,
    ],
  }),
  annotations: {},
  binding: {
    kind: "descendant_message",
    target: "agent.child",
    canonicalEffect: null,
  },
});

const SHELL_INPUT = objectSchema(["command"], {
  command: { type: "string", minLength: 1 },
  description: { type: "string", minLength: 1, maxLength: 1_000 },
  timeout_ms: POSITIVE_INTEGER,
  run_in_background: { type: "boolean" },
  verification_claim: {
    type: "string",
    enum: [
      "tests",
      "static_analysis",
      "runtime_verification",
      "security_scan",
      "performance_benchmark",
    ],
  },
});

const SHELL_STREAM_OUTPUT = objectSchema(
  [
    "text",
    "encoding",
    "encoding_source",
    "integrity",
    "replacement_count",
    "truncated",
    "overflow_file",
  ],
  {
    text: { type: "string" },
    encoding: { anyOf: [{ type: "string" }, { type: "null" }] },
    encoding_source: {
      enum: ["utf8", "bom", "detected", "fallback", "none"],
    },
    integrity: {
      enum: ["exact", "inferred", "lossy", "unavailable"],
    },
    replacement_count: { type: "integer", minimum: 0 },
    truncated: { type: "boolean" },
    overflow_file: { anyOf: [PATH, { type: "null" }] },
  },
);

const SHELL_OUTPUT = Object.freeze({
  oneOf: [
    objectSchema(
      [
        "mode",
        "exit_code",
        "signal",
        "duration_ms",
        "stdout",
        "stderr",
      ],
      {
        mode: { const: "foreground" },
        exit_code: { anyOf: [{ type: "integer" }, { type: "null" }] },
        signal: { anyOf: [{ type: "string" }, { type: "null" }] },
        duration_ms: { type: "integer", minimum: 0 },
        stdout: SHELL_STREAM_OUTPUT,
        stderr: SHELL_STREAM_OUTPUT,
      },
    ),
    objectSchema(["mode", "task_id", "status", "output_file"], {
      mode: { const: "background" },
      task_id: { type: "string", minLength: 1, maxLength: 1_024 },
      status: { const: "running" },
      output_file: PATH,
    }),
  ],
}) satisfies ToolJsonObject;

const BASH = shellContract("Bash");
const POWERSHELL = shellContract("PowerShell");

export const HELARC_BASELINE_TOOL_CONTRACTS = Object.freeze([
  READ,
  GLOB,
  GREP,
  EDIT,
  WRITE,
  BASH,
  POWERSHELL,
  TASK_STOP,
  ASK_USER_QUESTION,
  AGENT,
  SEND_MESSAGE,
] as const);

export function createHelarcBaselineToolContracts(
  shell: HelarcShellToolName,
): readonly HelarcBaselineToolContract[] {
  return Object.freeze(HELARC_BASELINE_TOOL_CONTRACTS.filter((item) =>
    item.name !== "Bash" && item.name !== "PowerShell" || item.name === shell
  ));
}

export function findHelarcBaselineToolContract(
  name: HelarcBaselineToolName,
): HelarcBaselineToolContract {
  const contract = HELARC_BASELINE_TOOL_CONTRACTS.find((item) => item.name === name);
  if (contract === undefined) {
    throw new TypeError(`Unknown Helarc baseline Tool '${name}'.`);
  }
  return contract;
}

function shellContract(name: HelarcShellToolName): HelarcBaselineToolContract {
  return contract({
    name,
    description: `Execute one bounded native ${name} command.`,
    inputSchema: SHELL_INPUT,
    outputSchema: SHELL_OUTPUT,
    annotations: { destructiveHint: true, openWorldHint: true },
    binding: operation("helarc.shell.execute", "process.spawn"),
  });
}

function operation(
  target: string,
  canonicalEffect: Extract<HelarcToolSettlementBinding, { kind: "operation" }>["canonicalEffect"],
): HelarcToolSettlementBinding {
  return Object.freeze({ kind: "operation" as const, target, canonicalEffect });
}

function contract(input: HelarcBaselineToolContract): HelarcBaselineToolContract {
  return Object.freeze({
    ...input,
    annotations: Object.freeze({ ...input.annotations }),
    binding: Object.freeze({ ...input.binding }),
  });
}

function objectSchema(
  required: readonly string[],
  properties: Readonly<Record<string, ToolJsonObject>>,
): ToolJsonObject {
  return Object.freeze({
    type: "object",
    additionalProperties: false,
    required: Object.freeze([...required]),
    properties: Object.freeze({ ...properties }),
  });
}

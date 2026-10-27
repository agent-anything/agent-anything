import type { ToolAnnotations, ToolJsonObject } from "@agent-anything/tools/catalog";
import {HELARC_PROCESS_OBSERVATION_SCHEMA, HELARC_PROCESS_WAIT_SCHEMA} from "./HelarcProcessSchemas.js";
import { EXECUTION_DETAILS_DESCRIPTION, EXECUTION_DETAILS_SCHEMA, EXECUTION_REFERENCE_SCHEMA } from "./HelarcExecutionDetails.js";
import { FILE_RESTORE_DESCRIPTION, FILE_RESTORE_SCHEMA } from "./HelarcFileRestoration.js";
import {CONTEXT_ACCESS_DEFINITIONS, MATERIAL_REFS_SCHEMA} from "./HelarcContextAccess.js";

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
  | "CommandStop"
  | "CommandObserve"
  | "ExecutionDetails"
  | "ContextMaterialSearch"
  | "ContextMaterialRead"
  | "RestoreFile"
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
        | "process.signal"
        | null;
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
  "helarc.baseline-tool-contracts.v5";

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
  description: "Read complete source lines from one exact Workspace file, preserving UTF-8 text and original line endings. Page using offset/limit and returned next_offset. The response byte limit is separate from the file inspection limit; an oversized single line is rejected rather than cut.",
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
      "next_offset",
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
      next_offset: { anyOf: [POSITIVE_INTEGER, {type: "null"}] },
      byte_length: { type: "integer", minimum: 0 },
      content_digest: { type: "string", minLength: 1, maxLength: 256 },
      truncated: { type: "boolean" },
    },
  ),
  annotations: { readOnlyHint: true },
  binding: operation("helarc.file.read", "file_system.read"),
});

const SEARCH_COVERAGE = objectSchema(["complete", "entries_visited", "files_searched", "bytes_read", "skipped_count", "skipped", "skipped_details_truncated", "stop_reason"], {
  complete: {type: "boolean"}, entries_visited: {type: "integer", minimum: 0},
  files_searched: {type: "integer", minimum: 0}, bytes_read: {type: "integer", minimum: 0},
  skipped_count: {type: "integer", minimum: 0}, skipped_details_truncated: {type: "boolean"},
  skipped: {type: "array", maxItems: 32, items: objectSchema(["file_path", "reason"], {file_path: PATH, reason: {type: "string"}})},
  stop_reason: {anyOf: [{type: "string"}, {type: "null"}]},
});
const OMITTED_COUNT = {anyOf: [{type: "integer", minimum: 0}, {type: "null"}]} as const;

const GLOB = contract({
  name: "Glob",
  description: "Find Workspace paths with one bounded glob pattern. Inspect scan.complete, skipped details and stop_reason: incomplete traversal is not proof of absence. omitted_count is null when the scan is incomplete. Narrow the scope when limited.",
  inputSchema: objectSchema(["pattern"], {
    pattern: { type: "string", minLength: 1, maxLength: 4_096 },
    path: PATH,
  }),
  outputSchema: objectSchema(["matches", "truncated", "omitted_count", "scan"], {
    matches: { type: "array", items: PATH },
    truncated: { type: "boolean" },
    omitted_count: OMITTED_COUNT,
    scan: SEARCH_COVERAGE,
  }),
  annotations: { readOnlyHint: true },
  binding: operation("helarc.path.glob", "file_system.read"),
});

const GREP = contract({
  name: "Grep",
  description: "Search Workspace text with one bounded regular expression. Inspect scan.complete, skipped details and stop_reason; oversized, unsupported or unreadable files and limits do not prove absence. Scanning can stop after the requested page. omitted_count is null for incomplete scans; narrow the scope or read an exact file to investigate.",
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
    ["output_mode", "entries", "truncated", "omitted_count", "scan"],
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
      omitted_count: OMITTED_COUNT,
      scan: SEARCH_COVERAGE,
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
  name: "CommandStop",
  description: "Request termination of one exact managed command owned by the current Run.",
  inputSchema: objectSchema(["task_id"], {
    task_id: { type: "string", minLength: 1, maxLength: 1_024 },
  }),
  outputSchema: objectSchema(["task_id", "snapshot", "effect_certainty"], {
    task_id: { type: "string", minLength: 1, maxLength: 1_024 },
    snapshot: {type:"object",description:"Exact managed process lifecycle facts, including root exit, containment, termination and output persistence."},
    effect_certainty: { enum: ["known_applied", "known_not_applied", "unknown"] },
  }),
  annotations: { destructiveHint: true, idempotentHint: true },
  binding: operation("helarc.task.stop", "process.signal"),
});

const COMMAND_OBSERVE = contract({
  name:"CommandObserve",description:"Observe one exact current-Run command, optionally waiting for a specified condition. Returns lifecycle facts and frozen stdout/stderr material references, not output text. Read or search those references with ContextMaterialRead/ContextMaterialSearch. Waiting never terminates the command, and a successful observation does not mean command success.",
  inputSchema:objectSchema(["task_id"],{task_id:{type:"string",minLength:1,maxLength:1024},
    until:{enum:["snapshot","change","outcome","settled"],description:"Default snapshot returns immediately. change waits for lifecycle/output changes since after; outcome waits for a known command outcome; settled waits for containment and capture settlement."},
    after:{type:"string",minLength:1,maxLength:2048,description:"Required only for change: an observation_id returned by CommandObserve for this exact command."},
    wait_ms:HELARC_PROCESS_WAIT_SCHEMA}),
  outputSchema:objectSchema(["task_id","run_id","observation_id","snapshot","output_materials","until","after","return_reason","requested_wait_ms","effective_wait_ms","elapsed_wait_ms"],{
    task_id:{type:"string"},run_id:{type:"string"},observation_id:{type:"string"},snapshot:{type:"object"},output_materials:{type:"array"},
    until:{enum:["snapshot","change","outcome","settled"]},after:{type:["string","null"]},return_reason:{type:"string"},
    requested_wait_ms:{type:"integer",minimum:0},effective_wait_ms:{type:"integer",minimum:0},elapsed_wait_ms:{type:"number",minimum:0}}),
  annotations:{readOnlyHint:true},binding:operation("helarc.command.observe",null),
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

const DELEGATION_TERMINAL_OUTPUT = objectSchema(["agent_id", "status", "summary", "artifact_refs", "effect_status", "uncertainty", "failure_code"], {
  agent_id: { anyOf: [{ type: "string", minLength: 1, maxLength: 1_024 }, { type: "null" }] },
  status: { enum: ["completed", "failed", "cancelled"] },
  summary: { type: "string", maxLength: 64_000 },
  artifact_refs: {
    type: "array",
    items: { type: "string", minLength: 1, maxLength: 1_024 },
  },
  effect_status: { type: "string" },
  uncertainty: {
    type: "array",
    items: { type: "string", minLength: 1, maxLength: 256 },
  },
  failure_code: { anyOf: [{ type: "string" }, { type: "null" }] },
  failure: {anyOf: [{type: "object"}, {type: "null"}]},
  execution_refs: {type: "array", maxItems: 16, items: EXECUTION_REFERENCE_SCHEMA},
  material_refs: MATERIAL_REFS_SCHEMA,
  execution_lookup: {anyOf: [{type: "null"}, {type: "object", properties: {
    reference: EXECUTION_REFERENCE_SCHEMA, view: {const: "executions"}, after: {type: "string"}}}]},
});

const DESCENDANT_PROGRESS_OUTPUT = objectSchema(
  ["agent_id", "status", "child_run_revision", "summary", "admitted_controls"],
  {
    agent_id: { type: "string", minLength: 1, maxLength: 1_024 },
    status: { enum: ["running", "suspended"] },
    child_run_revision: { type: "integer", minimum: 0 },
    summary: { type: "string", maxLength: 4_096 },
    admitted_controls: {
      type: "array",
      items: { enum: ["steer", "resume", "cancel"] },
    },
    steering_status: { type: "string" },
    resume_status: { type: "string" },
  },
);

const DELEGATION_RESULT_OUTPUT = Object.freeze({
  anyOf: Object.freeze([DELEGATION_TERMINAL_OUTPUT, DESCENDANT_PROGRESS_OUTPUT]),
}) satisfies ToolJsonObject;

const AGENT = contract({
  name: "Agent",
  description: "Delegate one bounded objective to a new descendant Agent.",
  inputSchema: objectSchema(["prompt"], {
    prompt: { type: "string", minLength: 1, maxLength: 64_000 },
    description: { type: "string", minLength: 1, maxLength: 1_024 },
    material_refs: MATERIAL_REFS_SCHEMA,
    execution_refs: {type: "array", maxItems: 16, items: EXECUTION_REFERENCE_SCHEMA,
      description: "Optional exact accessible execution/effect/support/material references to hand to this Child; at most 16. Textual IDs alone do not transfer access."},
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
  description: "Continue one exact retained descendant Agent context.",
  inputSchema: objectSchema(["agent_id", "prompt"], {
    agent_id: { type: "string", minLength: 1, maxLength: 1_024 },
    prompt: { type: "string", minLength: 1, maxLength: 64_000 },
    material_refs: MATERIAL_REFS_SCHEMA,
    execution_refs: {type: "array", maxItems: 16, items: EXECUTION_REFERENCE_SCHEMA,
      description: "Exact accessible execution references for a retained continuation. Active-Child steering accepts text only."},
  }),
  outputSchema: DELEGATION_RESULT_OUTPUT,
  annotations: {},
  binding: {
    kind: "descendant_message",
    target: "agent.child",
    canonicalEffect: null,
  },
});

const SHELL_INPUT = objectSchema(["command"], {
  command: { type: "string", minLength: 1 },
  description: { type: "string", minLength: 1 },
  timeout_ms: POSITIVE_INTEGER,
  wait_ms: HELARC_PROCESS_WAIT_SCHEMA,
  run_in_background: { type: "boolean" },
});


const BASH = shellContract("Bash");
const POWERSHELL = shellContract("PowerShell");

export const HELARC_BASELINE_TOOL_CONTRACTS = Object.freeze([
  ...CONTEXT_ACCESS_DEFINITIONS.map(value => contract({name: value.name, description: value.description, inputSchema: value.inputSchema,
    outputSchema: value.outputSchema, annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
    binding: operation(`helarc.${value.operation}`, null)})),
  contract({name: "RestoreFile", description: FILE_RESTORE_DESCRIPTION, inputSchema: FILE_RESTORE_SCHEMA,
    outputSchema: {type: "object"}, annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false},
    binding: operation("helarc.file-restoration", "file_system.write")}),
  contract({name: "ExecutionDetails", description: EXECUTION_DETAILS_DESCRIPTION, inputSchema: EXECUTION_DETAILS_SCHEMA,
    outputSchema: {type: "object"}, annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
    binding: operation("helarc.execution-details", null)}),
  READ,
  GLOB,
  GREP,
  EDIT,
  WRITE,
  BASH,
  POWERSHELL,
  TASK_STOP,
  COMMAND_OBSERVE,
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
    description: `Start one Run-owned native ${name} command and observe it for a bounded initial wait.`,
    inputSchema: SHELL_INPUT,
    outputSchema: HELARC_PROCESS_OBSERVATION_SCHEMA,
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

import type { ToolRevisionRef } from "@agent-anything/tools/identity";
import type { RegisteredTool } from "@agent-anything/tools/registration";
import { HELARC_COMPENSATION_GUIDANCE, HELARC_COMPENSATION_FIELD_GUIDANCE } from "../HelarcCompensationInput.js";
import { EXECUTION_DETAILS_DESCRIPTION } from "../HelarcExecutionDetails.js";
import { FILE_RESTORE_DESCRIPTION } from "../HelarcFileRestoration.js";
import {CONTEXT_ACCESS_DEFINITIONS} from "../HelarcContextAccess.js";
import {
  HELARC_BASELINE_TOOL_CONTRACTS,
  type HelarcBaselineToolName,
  type HelarcShellRuntimeProfile,
} from "../HelarcBaselineToolContracts.js";
import {
  createHelarcToolGuidanceCatalog,
  createHelarcToolGuidanceRelease,
  createHelarcToolGuidanceSource,
  type HelarcToolGuidanceCatalog,
  type HelarcToolGuidanceRelease,
  type HelarcToolGuidanceSource,
} from "./HelarcToolGuidance.js";

export const HELARC_BASELINE_TOOL_GUIDANCE_PROFILE_REVISION =
  "helarc.product-tool-guidance-profile.v2";
export const HELARC_BASELINE_TOOL_GUIDANCE_RELEASE_ID =
  "helarc.product-tool-guidance";

const REVIEWED_AT = "2026-08-30T00:00:00.000Z";

interface GuidanceDefinition {
  readonly description: string;
  readonly fields: Readonly<Record<string, string>>;
}

export interface HelarcBaselineToolGuidance {
  readonly catalog: HelarcToolGuidanceCatalog;
  readonly release: HelarcToolGuidanceRelease;
}

export function createHelarcBaselineToolGuidance(
  selectedTools: readonly RegisteredTool[],
  shellRuntime: HelarcShellRuntimeProfile,
): HelarcBaselineToolGuidance {
  const selectedByName = selectedToolsByName(selectedTools);
  if (!selectedByName.has(shellRuntime.toolName)) {
    throw new TypeError("Helarc Shell runtime does not match the selected native Shell Tool.");
  }
  const sources = Object.freeze(HELARC_BASELINE_TOOL_CONTRACTS.map((contract) =>
    createHelarcBaselineToolGuidanceSource(
      contract.name,
      selectedByName.get(contract.name)?.descriptor.ref ?? alternateShellRef(contract.name),
      contract.name === shellRuntime.toolName ? shellRuntime : null,
      selectedByName.get(contract.name)?.descriptor.inputSchema,
    )
  ));
  const release = createHelarcToolGuidanceRelease({
    id: HELARC_BASELINE_TOOL_GUIDANCE_RELEASE_ID,
    guidanceProfileRevision: HELARC_BASELINE_TOOL_GUIDANCE_PROFILE_REVISION,
    tools: sources.map(({ tool }) => tool),
    sources: sources.map(({ ref }) => ref),
    modelExtensions: [],
    createdAt: REVIEWED_AT,
    reviewedAt: REVIEWED_AT,
  });
  const catalog = createHelarcToolGuidanceCatalog({ sources, releases: [release] });
  return Object.freeze({ catalog, release });
}

export function createHelarcBaselineToolGuidanceSource(
  name: HelarcBaselineToolName,
  tool: ToolRevisionRef,
  shellRuntime: HelarcShellRuntimeProfile | null,
  inputSchema?: import("@agent-anything/tools/catalog").ToolJsonObject,
): HelarcToolGuidanceSource {
  if (shellRuntime !== null && name !== shellRuntime.toolName) {
    throw new TypeError("Helarc Shell runtime cannot describe a different Tool.");
  }
  const definition = shellRuntime === null ? DEFINITIONS[name] : shellRuntimeGuidance(shellRuntime);
  const fields: Record<string, string> = {...definition.fields};
  const compensation = inputSchema?.properties && typeof inputSchema.properties === "object" &&
    !Array.isArray(inputSchema.properties) && Object.hasOwn(inputSchema.properties, "compensation_of");
  if (compensation) Object.assign(fields, HELARC_COMPENSATION_FIELD_GUIDANCE);
  if (shellRuntime && inputSchema?.properties && typeof inputSchema.properties === "object" && !Array.isArray(inputSchema.properties)) {
    const properties = inputSchema.properties as import("@agent-anything/tools/catalog").ToolJsonObject;
    // These descriptions are rendered by the command contract from its effective constraints.
    for (const field of ["command", "description", "timeout_ms", "wait_ms", "run_in_background"]) {
      const schema = properties[field];
      if (schema && typeof schema === "object" && !Array.isArray(schema) && "description" in schema && typeof schema.description === "string") {
        const pointer = `/properties/${field}`;
        fields[pointer] = field === "command" || field === "description"
          ? `${fields[pointer]} ${schema.description}` : schema.description;
      }
    }
  }
  return createHelarcToolGuidanceSource({
    id: `helarc.tool-guidance.${sourceName(name)}`,
    tool,
    modelDescription: [definition.description, typeof inputSchema?.description === "string" ? inputSchema.description : "",
      compensation ? HELARC_COMPENSATION_GUIDANCE : ""].filter(Boolean).join(" "),
    inputFieldDescriptions: fields,
    provenance: Object.freeze({
      reference: "authored:helarc-product-tool-guidance-v2",
      license: null,
      reviewedAt: REVIEWED_AT,
    }),
  });
}

function selectedToolsByName(
  tools: readonly RegisteredTool[],
): ReadonlyMap<HelarcBaselineToolName, RegisteredTool> {
  const selected = new Map<HelarcBaselineToolName, RegisteredTool>();
  for (const tool of tools) {
    if (!isBaselineToolName(tool.descriptor.name)) {
      throw new TypeError(`Helarc Tool Guidance does not recognize '${tool.descriptor.name}'.`);
    }
    if (selected.has(tool.descriptor.name)) {
      throw new TypeError(`Helarc Tool Selection duplicates '${tool.descriptor.name}'.`);
    }
    selected.set(tool.descriptor.name, tool);
  }
  for (const contract of HELARC_BASELINE_TOOL_CONTRACTS) {
    if (
      contract.name !== "Bash" && contract.name !== "PowerShell" &&
      !selected.has(contract.name)
    ) {
      throw new TypeError(`Helarc Tool Selection is missing '${contract.name}'.`);
    }
  }
  const selectedShells = Number(selected.has("Bash")) + Number(selected.has("PowerShell"));
  if (selectedShells !== 1) {
    throw new TypeError("Helarc Tool Selection requires exactly one native Shell Tool.");
  }
  return selected;
}

function alternateShellRef(name: HelarcBaselineToolName): ToolRevisionRef {
  if (name !== "Bash" && name !== "PowerShell") {
    throw new TypeError(`Helarc Tool Selection is missing '${name}'.`);
  }
  return Object.freeze({
    tool: Object.freeze({ namespace: "helarc", name: name.toLowerCase() }),
    revision: "2",
  });
}

function isBaselineToolName(name: string): name is HelarcBaselineToolName {
  return HELARC_BASELINE_TOOL_CONTRACTS.some((contract) => contract.name === name);
}

function sourceName(name: HelarcBaselineToolName): string {
  return name.replace(/([a-z])([A-Z])/gu, "$1-$2").toLowerCase();
}

const DEFINITIONS = Object.freeze({
  ContextMaterialSearch: {description: CONTEXT_ACCESS_DEFINITIONS[0]!.description, fields: {
    "/properties/query": "Optional case-sensitive literal, at most 1024 UTF-8 bytes. Omit to enumerate accessible material.",
    "/properties/in": "content (default) or description. No semantic search or regex.",
    "/properties/limit": "Maximum matches per page, 1-16; scan coverage is bounded separately.",
    "/properties/cursor": "Exact nextCursor with the same query, mode and references; preserves the first page's membership frontier.",
    "/properties/references":"Optional 1-16 exact references for a targeted search; command output views require this explicit scope.",
    "/properties/references/items/properties/id":"Copy the exact material id from a command result or material handoff.",
    "/properties/references/items/properties/revision":"Copy the exact immutable sha256 revision; later output has a different reference.",
  }},
  ContextMaterialRead: {description: CONTEXT_ACCESS_DEFINITIONS[1]!.description, fields: {
    "/properties/reference": "Exact retained material reference disclosed to this Run, not a path.",
    "/properties/reference/properties/id": "Copy the exact material identity.",
    "/properties/reference/properties/revision": "Copy the exact immutable sha256 revision.",
    "/properties/offset": "Zero-based UTF-8 byte offset. Prefer returned nextOffset; defaults to zero.",
    "/properties/length": "Maximum text bytes, 4-16384; defaults to 16384 and never splits a UTF-8 character.",
  }},
  RestoreFile: {description: FILE_RESTORE_DESCRIPTION, fields: {
    "/properties/change_ref": "Exact file effect reference to address. It selects the recorded target and prior state, not a replacement path.",
    "/properties/change_ref/properties/owner": "Copy the effect owner exactly.",
    "/properties/change_ref/properties/kind": "Must be effect.",
    "/properties/change_ref/properties/id": "Copy the exact disclosed file effect ID.",
    "/properties/change_ref/properties/revision": "Copy the immutable effect revision exactly.",
  }},
  ExecutionDetails: {description: EXECUTION_DETAILS_DESCRIPTION, fields: {
    "/properties/reference": "Exact owner-issued reference delivered to this Run. It is not authority to read retained content.",
    "/properties/reference/properties/owner": "Copy the source owner exactly.",
    "/properties/reference/properties/kind": "Copy execution, effect, support or material exactly.",
    "/properties/reference/properties/id": "Copy the disclosed immutable identity; do not guess paths or IDs.",
    "/properties/reference/properties/revision": "Copy the immutable revision exactly.",
    "/properties/view": "summary by default; content requires a material reference and current source-owner read authority; executions pages an explicitly disclosed settled Run collection.",
    "/properties/after": "Opaque executions-page cursor copied exactly from next; omit on the first page. Not used for summary or content.",
    "/properties/offset": "Zero-based entry offset for summary or byte offset for content; default zero.",
    "/properties/limit": "Summary returns 1-16 entries (default 4); content returns 1-16384 bytes (default 4096). Use the returned next offset.",
  }},
  Read: Object.freeze({
    description: "Read bounded UTF-8 text from one exact file in the active Workspace. Use it to inspect textual state before proposing a mutation. Returns complete source lines with original line endings and BOM preserved, content_digest for the inspected file, and next_offset for another page. The page byte limit is separate from the total file inspection limit, so a large file may be read in pages. Compare content_digest between pages; a live file is not a frozen material version. A single line too large to return is an explicit failure, not partial text. Prefer Glob for path discovery and Grep for searching content across files. Do not treat omitted content as observed or use this Tool for binary media.",
    fields: Object.freeze({
      "/properties/file_path": "Workspace-relative path of the exact textual file to read. Do not provide an absolute path or a path outside the active Workspace.",
      "/properties/limit": "Optional maximum complete source lines. Original line endings are retained. Returned bytes and total file inspection have separate Host limits; a line that cannot fit is rejected rather than silently cut.",
      "/properties/offset": "Optional one-based first line. Follow next_offset to continue a page; a null next_offset means the file end. Pages describe a particular content_digest, not a frozen file across calls.",
    }),
  }),
  Glob: Object.freeze({
    description: "Discover Workspace paths that match one bounded glob pattern. Use it when the relevant path or file set is unknown. Prefer Read for a known file and Grep for content matching. Inspect scan.complete, scan.stop_reason and scan.skipped before concluding absence. Traversal, depth, time, results and output are bounded; symlinks are not followed. Incomplete scans have omitted_count null, not an invented remaining total. Only a complete empty scan establishes no matches in the requested scope. Narrow the pattern or path when coverage is insufficient.",
    fields: Object.freeze({
      "/properties/path": "Optional Workspace-relative directory that bounds the search. Omit it to search from the active Workspace root.",
      "/properties/pattern": "Required glob pattern used to match Workspace-relative paths. Choose the narrowest pattern that can answer the current question.",
    }),
  }),
  Grep: Object.freeze({
    description: "Search Workspace UTF-8 text with one regular expression. Prefer Glob for name-only discovery and Read for full or ranged inspection of a known file. Inspect scan.complete, scan.stop_reason and scan.skipped: unreadable, non-text, oversized and changed files are reported as skipped, not searched with zero matches. Traversal, input bytes, regex time, matches and output are bounded. Incomplete scans have omitted_count null; count mode returns only completed per-file counts. An empty page establishes no matches only when scan.complete is true and omitted_count is zero; offset may hide earlier matches. Narrow the scope or expression, or follow with Read when coverage is insufficient.",
    fields: Object.freeze({
      "/properties/after_context": "Optional number of lines requested after each content match. It is relevant to content output and remains Host-bounded.",
      "/properties/before_context": "Optional number of lines requested before each content match. It is relevant to content output and remains Host-bounded.",
      "/properties/case_sensitive": "Whether matching is case-sensitive. Omit it for the Product default of case-sensitive matching.",
      "/properties/glob": "Optional glob filter applied to candidate Workspace files before content matching.",
      "/properties/limit": "Optional maximum number of returned entries after offset. The Host also applies its configured upper bound.",
      "/properties/multiline": "Whether the regular expression may match across line boundaries. Use only when the intended expression requires multiline content.",
      "/properties/offset": "Optional one-based offset into this search's traversal result. Omit it for the first match. Separate calls are not a frozen search snapshot; prefer narrowing the path when incomplete.",
      "/properties/output_mode": "Result representation: content returns matched text and location, files_with_matches returns matching paths, and count returns per-file counts. Omit it for content.",
      "/properties/path": "Optional Workspace-relative file or directory that bounds the search. Omit it to search from the active Workspace root.",
      "/properties/pattern": "Required regular expression. Escape it for the JSON Tool input and express only the content condition required by the current search.",
    }),
  }),
  Edit: Object.freeze({
    description: "Replace exact existing text in one Workspace file against its current baseline. Use it for a localized change after reading enough current content to supply an exact old_string. Prefer Write for a genuinely new file or intentional complete replacement. By default the old text must identify one occurrence; set replace_all only when every exact occurrence should change. Empty new_string deletes the matched text. A missing target, stale baseline, absent match, or non-unique match is not success: re-read the file, narrow the match, and submit a new exact edit rather than guessing.",
    fields: Object.freeze({
      "/properties/file_path": "Workspace-relative path of the existing file to edit.",
      "/properties/new_string": "Literal replacement text, including dollar signs and original line endings; no replacement-template expansion. It may be empty to delete the matched old_string.",
      "/properties/old_string": "Non-empty exact text expected in the current file baseline. Include enough surrounding content to make the intended match unambiguous.",
      "/properties/replace_all": "Set true only when every exact old_string occurrence should be replaced. Omit or use false for one unique occurrence.",
    }),
  }),
  Write: Object.freeze({
    description: "Create one Workspace file or replace one file with complete supplied content. Use it for a new file or when full replacement is deliberate and the entire desired content is known. Read an existing target before replacing it so current work is not discarded accidentally; prefer Edit for localized changes. The content field is authoritative for the whole resulting file and may be empty when an empty file is intended. A path conflict, stale target state, size limit, or write failure is not completion; inspect the current state and issue a corrected request.",
    fields: Object.freeze({
      "/properties/content": "Complete UTF-8 content for the resulting file. Use an empty string only when the intended file is empty.",
      "/properties/file_path": "Workspace-relative path of the file to create or completely replace.",
    }),
  }),
  Bash: shellGuidance("Bash", "POSIX-compatible native shell syntax"),
  PowerShell: shellGuidance("PowerShell", "PowerShell native syntax"),
  CommandStop: Object.freeze({
    description: "Request termination of one exact managed command or its remaining descendants owned by the current Run, using the task_id from Shell or CommandObserve. It does not stop the Agent Run. The returned snapshot distinguishes signal application, root exit, contained descendants and output persistence. A termination request is not proof of empty containment; unknown effect must remain unknown. After root exit, remaining descendants can still be stopped without rewriting the command outcome. Retrieve current facts and output references with CommandObserve; read the references with ContextMaterialRead.",
    fields: Object.freeze({
      "/properties/task_id": "Exact current-Run command identity returned by Shell or CommandObserve; never invent a PID or use another Run's identity.",
    }),
  }),
  CommandObserve: Object.freeze({
    description: "Observe one exact command owned by this Run without starting, stopping or reading its output. snapshot (default) returns immediately; change waits for lifecycle or captured-output changes since a prior CommandObserve observation_id; outcome waits for a known command outcome; settled waits for resource/capture settlement. Copy the exact task_id from Shell and after from CommandObserve. Returns the snapshot, condition, wait duration, return reason and frozen stdout/stderr output_materials references. Read these with ContextMaterialRead or search explicit references with ContextMaterialSearch. A wait limit or cancellation of this observation leaves the command running. Successful observation is not command success; inspect outcome, root exit, containment and capture quality. An unresolved recovered command reports uncertainty instead of waiting for an impossible live update.",
    fields:Object.freeze({
      "/properties/task_id":"Exact command identity from a Shell result in this Run; material access does not grant command control.",
      "/properties/until":"snapshot (default), change, outcome or settled. These are different conditions, not interchangeable success checks.",
      "/properties/after":"Only for change, required: exact prior CommandObserve observation_id for this command.",
      "/properties/wait_ms":"Bounded observation wait only: default 10000ms; zero or 1000-30000ms. snapshot is always immediate."
    }),
  }),
  AskUserQuestion: Object.freeze({
    description: "Request bounded missing information or a user decision when safe useful progress cannot be chosen from current evidence. This is clarification only: answers do not grant permission or change execution limits. Ask only questions whose answers materially change the next action; do not ask for facts available through active Tools, repeat answered questions, or use clarification as a routine progress update. Keep each prompt concrete, provide concise mutually distinct options when known, and allow free text where predefined options are insufficient. The Run blocks for the correlated answer, so combine related questions without collecting unrelated information.",
    fields: Object.freeze({
      "/properties/questions": "One to four related clarification questions required for the next safe decision.",
      "/properties/questions/items/properties/allow_multiple": "Whether the user may select more than one listed option for this question.",
      "/properties/questions/items/properties/id": "Stable short identifier unique within this request and used to correlate the answer.",
      "/properties/questions/items/properties/options": "Optional list of one to eight concise mutually distinguishable choices. Omit it when free-form input is more appropriate.",
      "/properties/questions/items/properties/options/items/properties/description": "Short explanation of the consequence or meaning of selecting this option.",
      "/properties/questions/items/properties/options/items/properties/label": "Concise user-facing option label unique within this question.",
      "/properties/questions/items/properties/prompt": "Concrete question explaining the missing decision without exposing protected internal data.",
    }),
  }),
  Agent: Object.freeze({
    description: "Delegate one bounded, self-contained objective to a new descendant Agent when isolation or independent analysis improves progress. Work directly when the task is small, tightly sequential, or depends on rapidly changing local context. The prompt must include the objective, relevant constraints, expected contribution, and only the context the descendant needs; do not assume it can infer omitted conversation state. One Agent call requests one Child. Several independent Agent calls emitted together in the same response request concurrent sibling dispatch; dependent work must wait for those results and be emitted in a later response. Treat each returned summary, artifact, verification fact, effect, limitation, and failure status as bounded descendant material, not as proof beyond its recorded evidence. When agent_id is present, use SendMessage to continue that exact retained context; otherwise start fresh with Agent.",
    fields: Object.freeze({
      "/properties/description": "Optional concise label for the delegated work, used for human-readable progress and diagnostics.",
      "/properties/execution_refs": "Optional bounded explicit handoff of references already accessible to this Run. Does not grant read or mutation authority.",
      "/properties/material_refs": "Optional explicit handoff of at most 16 accessible retained context views. Does not share other history or file permissions.",
      "/properties/material_refs/items/properties/id": "Copy the exact material identity returned by ContextMaterialSearch or a prior handoff.",
      "/properties/material_refs/items/properties/revision": "Copy the exact immutable sha256 revision.",
      "/properties/execution_refs/items/properties/owner": "Copy the exact disclosed source owner.",
      "/properties/execution_refs/items/properties/kind": "Copy the exact execution, effect, support or material kind.",
      "/properties/execution_refs/items/properties/id": "Copy the exact disclosed identity; do not invent IDs.",
      "/properties/execution_refs/items/properties/revision": "Copy the exact immutable revision.",
      "/properties/prompt": "Self-contained delegated objective with necessary context, constraints, and expected output.",
    }),
  }),
  SendMessage: Object.freeze({
    description: "Send one bounded follow-up prompt to one exact descendant context. Use the opaque agent_id returned by Agent, do not invent identifiers, and use Agent for fresh isolated context. A retained continuation may receive explicit material_refs and execution_refs accessible to this Run, in addition to its inherited context. An active Child accepts text steering only; reference attachments are rejected without sending the prompt. Continuation does not widen file or execution authority or make prior uncertain effects safe to replay.",
    fields: Object.freeze({
      "/properties/agent_id": "Opaque continuation identity returned by a settled Agent call. Copy it exactly.",
      "/properties/prompt": "Bounded follow-up instruction for the retained descendant context.",
      "/properties/material_refs": "Optional accessible immutable material references for a retained continuation only; at most 16. These are not automatically read.",
      "/properties/material_refs/items/properties/id": "Copy the exact disclosed material identity.",
      "/properties/material_refs/items/properties/revision": "Copy the exact immutable sha256 revision.",
      "/properties/execution_refs": "Optional accessible execution references for a retained continuation only. Does not grant read or mutation authority.",
      "/properties/execution_refs/items/properties/owner": "Copy the exact disclosed source owner.",
      "/properties/execution_refs/items/properties/kind": "Copy the exact execution, effect, support or material kind.",
      "/properties/execution_refs/items/properties/id": "Copy the exact disclosed identity; do not invent IDs.",
      "/properties/execution_refs/items/properties/revision": "Copy the exact immutable revision.",
    }),
  }),
} satisfies Readonly<Record<HelarcBaselineToolName, GuidanceDefinition>>);

function shellGuidance(
  name: "Bash" | "PowerShell",
  syntax: string,
  runtimeConstraint = "",
): GuidanceDefinition {
  return Object.freeze({
    description: `Start one Run-owned native ${name} command in the active Workspace using ${syntax}.${runtimeConstraint} Prefer dedicated file Tools for reading, searching and editing. Startup is subject to normal execution authority. After confirmed startup, observe for wait_ms using its declared default and return an exact task_id, snapshot, bounded stdout/stderr and frozen output_materials references for full retained details. A continuing result with no outcome is not command completion: use CommandObserve for further observation, and CommandStop when termination is needed. Do not start the same command again merely because its initial wait expired. run_in_background selects immediate observation, not detached Run ownership. timeout_ms starts at process launch and ends at root exit; the Run deadline still bounds surviving descendants. Only a foreground command whose root has exited during initial observation can update this Run's Shell working directory; later CommandObserve cannot. outcome describes the command result, while phase describes resource settlement. A known outcome can coexist with active descendants or open output; use CommandObserve to capture later output references, then ContextMaterialRead or ContextMaterialSearch to inspect them. Frozen output_materials references never grow. Run finalization terminates remaining owned resources without rewriting the command outcome.`,
    fields: Object.freeze({
      "/properties/command": `Required command string interpreted by the Host-selected native ${name} executable. Use ${syntax} and quote paths and values correctly for that shell.${runtimeConstraint}`,
      "/properties/description": "Optional concise explanation of the command's intended effect for progress and review surfaces.",
      "/properties/run_in_background": "True requests immediate return after startup; wait_ms must be absent or zero. False still allows a continuing result after the bounded wait.",
      "/properties/wait_ms": "Initial observation wait, not an execution timeout. Zero is immediate; use the bound command contract's limits and default.",
      "/properties/timeout_ms": "Optional positive execution timeout in milliseconds. Omit it for the Host default; the Host enforces its maximum.",
    }),
  });
}

function shellRuntimeGuidance(runtime: HelarcShellRuntimeProfile): GuidanceDefinition {
  switch (runtime.dialect) {
    case "bash":
      return shellGuidance(
        "Bash",
        "Bash syntax",
        " The Host executes this Tool with `bash`; conditional command chains may use `&&` and `||`.",
      );
    case "powershell-7":
      return shellGuidance(
        "PowerShell",
        "PowerShell 7 syntax",
        " The Host executes this Tool with `pwsh`; pipeline-chain operators `&&` and `||` are supported.",
      );
    case "windows-powershell":
      return shellGuidance(
        "PowerShell",
        "Windows PowerShell syntax",
        " The Host executes this Tool with Windows PowerShell `powershell`. Do not use `&&` or `||`; they are not valid statement separators. Prefer separate Tool Calls for success-dependent steps, or explicitly guard the later statement with `$LASTEXITCODE` or PowerShell exception semantics. Do not substitute `;` for conditional chaining because it runs the later statement regardless of the earlier native command's exit code.",
      );
  }
}

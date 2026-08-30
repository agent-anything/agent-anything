import type { ToolRevisionRef } from "@agent-anything/tools/identity";
import type { RegisteredTool } from "@agent-anything/tools/registration";
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
): HelarcToolGuidanceSource {
  if (shellRuntime !== null && name !== shellRuntime.toolName) {
    throw new TypeError("Helarc Shell runtime cannot describe a different Tool.");
  }
  const definition = shellRuntime === null ? DEFINITIONS[name] : shellRuntimeGuidance(shellRuntime);
  return createHelarcToolGuidanceSource({
    id: `helarc.tool-guidance.${sourceName(name)}`,
    tool,
    modelDescription: definition.description,
    inputFieldDescriptions: definition.fields,
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
  Read: Object.freeze({
    description: "Read bounded UTF-8 text from one exact file in the active Workspace. Use it to inspect code, configuration, documentation, or other textual state, and read an existing file before proposing a mutation. Use offset and limit for focused follow-up reads. Prefer Glob for path discovery and Grep for searching content across files. Do not treat omitted or truncated content as observed, do not use this Tool for binary media, and do not claim a file state that the returned baseline does not establish. A missing, inaccessible, oversized, or non-text target is a failed observation and should lead to a corrected path, narrower request, or another applicable Tool.",
    fields: Object.freeze({
      "/properties/file_path": "Workspace-relative path of the exact textual file to read. Do not provide an absolute path or a path outside the active Workspace.",
      "/properties/limit": "Optional maximum number of lines to return. The Host also applies its configured upper bound.",
      "/properties/offset": "Optional one-based line at which reading begins. Omit it to begin at line 1.",
    }),
  }),
  Glob: Object.freeze({
    description: "Discover Workspace paths that match one bounded glob pattern. Use it when the relevant path or file set is unknown, before reading or searching selected matches. Prefer Read when the exact file is already known and Grep when selection depends on file contents. Results are bounded and may be truncated; an empty result means no returned path matched the request, not that related files cannot exist under another pattern or base path. Refine the pattern or path when coverage is insufficient, and never invent omitted matches.",
    fields: Object.freeze({
      "/properties/path": "Optional Workspace-relative directory that bounds the search. Omit it to search from the active Workspace root.",
      "/properties/pattern": "Required glob pattern used to match Workspace-relative paths. Choose the narrowest pattern that can answer the current question.",
    }),
  }),
  Grep: Object.freeze({
    description: "Search bounded Workspace text with one regular expression. Use it to locate symbols, literals, configuration, or other textual evidence across candidate files. Prefer Glob for name-only discovery and Read for complete or carefully ranged inspection of a known file. Select an output mode that matches the question, inspect returned file content before relying on surrounding semantics, and respect truncation and omitted counts. Invalid expressions, unreadable or oversized files, and bounded omissions do not establish absence; narrow the scope, adjust the expression, or follow with Read as appropriate.",
    fields: Object.freeze({
      "/properties/after_context": "Optional number of lines requested after each content match. It is relevant to content output and remains Host-bounded.",
      "/properties/before_context": "Optional number of lines requested before each content match. It is relevant to content output and remains Host-bounded.",
      "/properties/case_sensitive": "Whether matching is case-sensitive. Omit it for the Product default of case-sensitive matching.",
      "/properties/glob": "Optional glob filter applied to candidate Workspace files before content matching.",
      "/properties/limit": "Optional maximum number of returned entries after offset. The Host also applies its configured upper bound.",
      "/properties/multiline": "Whether the regular expression may match across line boundaries. Use only when the intended expression requires multiline content.",
      "/properties/offset": "Optional one-based offset into the bounded ordered match set. Omit it to begin with the first match.",
      "/properties/output_mode": "Result representation: content returns matched text and location, files_with_matches returns matching paths, and count returns per-file counts. Omit it for content.",
      "/properties/path": "Optional Workspace-relative file or directory that bounds the search. Omit it to search from the active Workspace root.",
      "/properties/pattern": "Required regular expression. Escape it for the JSON Tool input and express only the content condition required by the current search.",
    }),
  }),
  Edit: Object.freeze({
    description: "Replace exact existing text in one Workspace file against its current baseline. Use it for a localized change after reading enough current content to supply an exact old_string. Prefer Write for a genuinely new file or intentional complete replacement. By default the old text must identify one occurrence; set replace_all only when every exact occurrence should change. Empty new_string deletes the matched text. A missing target, stale baseline, absent match, or non-unique match is not success: re-read the file, narrow the match, and submit a new exact edit rather than guessing.",
    fields: Object.freeze({
      "/properties/file_path": "Workspace-relative path of the existing file to edit.",
      "/properties/new_string": "Exact replacement text. It may be empty to delete the matched old_string.",
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
  TaskStop: Object.freeze({
    description: "Stop one exact background command task owned by the current Run. Use it only for a task_id returned by a prior background Shell result when that process should no longer continue. Do not use it for foreground commands, unknown tasks, other Runs, or as a substitute for stopping the Agent Run. A completed result means the task had already settled; a stopped result records the confirmed stop settlement. If effect certainty is unknown, do not claim that termination is confirmed.",
    fields: Object.freeze({
      "/properties/task_id": "Exact current-Run background task identity returned by a prior Bash or PowerShell call.",
    }),
  }),
  AskUserQuestion: Object.freeze({
    description: "Request bounded missing information or a user decision when safe useful progress cannot be chosen from current evidence. Ask only questions whose answers materially change the next action; do not ask for facts available through active Tools, repeat answered questions, or use clarification as a routine progress update. Keep each prompt concrete, provide concise mutually distinct options when known, and allow free text where predefined options are insufficient. The Run blocks for the correlated answer, so combine related questions without collecting unrelated information.",
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
    description: "Delegate one bounded, self-contained objective to a new general-purpose descendant Agent when isolation or independent analysis improves progress. Work directly when the task is small, tightly sequential, or depends on rapidly changing local context. The prompt must include the objective, relevant constraints, expected result, and only the context the descendant needs; do not assume it can infer omitted conversation state. Use dependency_result for work that consumes an earlier result and replaced_result only when a new Run supersedes that result. Treat the returned summary, artifacts, verification, effects, limitations, and failure status as bounded descendant material, not as proof beyond its recorded evidence. Use SendMessage, not Agent, to continue one exact settled child context.",
    fields: Object.freeze({
      "/properties/description": "Optional concise label for the delegated work, used for human-readable progress and diagnostics.",
      "/properties/dependency_result": "Optional exact settled result consumed as a dependency by the new descendant.",
      "/properties/dependency_result/properties/id": "Identity of the exact dependency result.",
      "/properties/dependency_result/properties/revision": "Immutable revision of the dependency result.",
      "/properties/prompt": "Self-contained delegated objective with necessary context, constraints, and expected output.",
      "/properties/replaced_result": "Optional exact settled result superseded by this new descendant.",
      "/properties/replaced_result/properties/id": "Identity of the exact result being replaced.",
      "/properties/replaced_result/properties/revision": "Immutable revision of the result being replaced.",
    }),
  }),
  SendMessage: Object.freeze({
    description: "Send one bounded follow-up instruction to one exact descendant target advertised by the current Run. An active target steers the same Child Run; a continuation target consumes one retained same-process child context and starts one successor Run. Use the exact current target identity, do not invent identifiers, and use Agent instead when the work should begin with a fresh isolated context. Delivery does not widen authority, revive a settled Run, or make prior uncertain effects safe to replay.",
    fields: Object.freeze({
      "/properties/message": "Bounded follow-up instruction for the selected descendant context.",
      "/properties/target": "Exact active-child or continuation target currently advertised by the Run.",
      "/properties/target/properties/id": "Opaque current target identity. Copy it exactly from the advertised descendant targets.",
      "/properties/target/properties/kind": "Use active for the same running child or continuation for a retained settled-child context.",
    }),
  }),
} satisfies Readonly<Record<HelarcBaselineToolName, GuidanceDefinition>>);

function shellGuidance(
  name: "Bash" | "PowerShell",
  syntax: string,
  runtimeConstraint = "",
): GuidanceDefinition {
  return Object.freeze({
    description: `Execute one bounded native ${name} command in the active Workspace using ${syntax}.${runtimeConstraint} Use it for build, test, static-analysis, runtime, package, Git, and other command-line work that has no more precise admitted Tool. Prefer Read, Glob, Grep, Edit, or Write for their dedicated file responsibilities. Compose a command whose effects and failure behavior are understandable, avoid destructive or irreversible operations unless explicitly required and authorized, and never infer success from intent. Foreground results settle with exit code, stdout, stderr, duration, and truncation state. Background results return a task_id rather than command completion and must be observed through later context or stopped with TaskStop. Timeouts, nonzero exits, truncated output, uncertain effects, and missing verification require explicit interpretation and recovery.`,
    fields: Object.freeze({
      "/properties/command": `Required command string interpreted by the Host-selected native ${name} executable. Use ${syntax} and quote paths and values correctly for that shell.${runtimeConstraint}`,
      "/properties/description": "Optional concise explanation of the command's intended effect for progress and review surfaces.",
      "/properties/run_in_background": "Set true only when the command should continue asynchronously. A background result means started, not completed.",
      "/properties/timeout_ms": "Optional positive execution timeout in milliseconds. Omit it for the Host default; the Host enforces its maximum.",
      "/properties/verification_claim": "Optional exact claim that this command is intended to verify: tests, static_analysis, runtime_verification, security_scan, or performance_benchmark. Use it only when the command result can support that claim.",
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

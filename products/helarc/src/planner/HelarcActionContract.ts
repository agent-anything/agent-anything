export type HelarcPlannerActionName =
  | "call_tool"
  | "complete"
  | "propose"
  | "stop";

export interface HelarcPlannerActionDescription {
  action: HelarcPlannerActionName;
  purpose: string;
  requiredFields: string[];
  optionalFields: string[];
}

export interface HelarcActionDecisionRule {
  id: string;
  text: string;
}

export interface HelarcActionContract {
  actions: HelarcPlannerActionDescription[];
  decisionRules: HelarcActionDecisionRule[];
}

export const HELARC_PLANNER_ACTIONS = [
  "call_tool",
  "complete",
  "propose",
  "stop",
] as const satisfies readonly HelarcPlannerActionName[];

const HELARC_ACTION_DESCRIPTIONS: HelarcPlannerActionDescription[] = [
  {
    action: "call_tool",
    purpose: "Request one tool execution from the active tool catalog.",
    requiredFields: ["action", "toolName", "input"],
    optionalFields: ["reason", "toolCallId"],
  },
  {
    action: "complete",
    purpose: "Finish the task when the answer is ready or no file change is needed.",
    requiredFields: ["action", "summary"],
    optionalFields: [],
  },
  {
    action: "propose",
    purpose: "Propose one file creation, update, or deletion for Helarc patch review.",
    requiredFields: ["action", "summary", "change"],
    optionalFields: [],
  },
  {
    action: "stop",
    purpose: "Stop safely when the task cannot continue.",
    requiredFields: ["action", "reason"],
    optionalFields: [],
  },
];

const HELARC_ACTION_DECISION_RULES: HelarcActionDecisionRule[] = [
  {
    id: "active_tool_catalog_only",
    text: "Use call_tool only for tools listed in the active tool catalog.",
  },
  {
    id: "list_files_for_directory_discovery",
    text: "Use codeAgent.listFiles for directory discovery.",
  },
  {
    id: "read_file_for_known_file",
    text: "Use codeAgent.readFile for reading a known file.",
  },
  {
    id: "search_files_for_text_search",
    text: "Use codeAgent.searchFiles for text search across files.",
  },
  {
    id: "propose_for_file_changes",
    text: "Use propose for file creation, update, or deletion.",
  },
  {
    id: "complete_when_answered",
    text: "Use complete when the task is answered or no change is needed.",
  },
  {
    id: "stop_when_unsafe",
    text: "Use stop when the task cannot continue safely.",
  },
  {
    id: "do_not_invent_write_tools",
    text: "Do not invent write tools such as codeAgent.writeFile.",
  },
  {
    id: "shell_requires_catalog_exposure",
    text: "Do not use shell unless the host explicitly exposes shell in the active tool catalog.",
  },
];

export function createHelarcActionContract(): HelarcActionContract {
  return {
    actions: HELARC_ACTION_DESCRIPTIONS.map((action) => ({ ...action })),
    decisionRules: HELARC_ACTION_DECISION_RULES.map((rule) => ({ ...rule })),
  };
}

export function buildHelarcActionProtocolText(
  contract: HelarcActionContract = createHelarcActionContract(),
): string {
  return [
    `Use one of these actions: ${contract.actions.map((item) => item.action).join(", ")}.`,
    ...contract.actions.map(formatActionDescription),
  ].join("\n");
}

export function buildHelarcActionDecisionRulesText(
  contract: HelarcActionContract = createHelarcActionContract(),
): string {
  return contract.decisionRules.map((rule) => rule.text).join("\n");
}

function formatActionDescription(action: HelarcPlannerActionDescription): string {
  const required = action.requiredFields.join(", ");
  const optional = action.optionalFields.length > 0
    ? `, and optional ${action.optionalFields.join(", ")}`
    : "";

  return `For ${action.action}, return ${required}${optional}.`;
}

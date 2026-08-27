import {
  snapshotModelOutputFormat,
  type StructuredOutputFormat,
} from "@agent-anything/model-interaction/input";
import type { ToolExposureProof } from "@agent-anything/tools/selection";

export type HelarcControllerDecisionKind =
  | "tool_call"
  | "plan_update"
  | "completion"
  | "stop";

export interface HelarcControllerDecisionDescription {
  kind: HelarcControllerDecisionKind;
  purpose: string;
  requiredFields: string[];
  optionalFields: string[];
  constraints: string[];
}

export interface HelarcActionDecisionRule {
  id: string;
  text: string;
}

export interface HelarcActionContract {
  decisions: HelarcControllerDecisionDescription[];
  decisionRules: HelarcActionDecisionRule[];
}

export const HELARC_CONTROLLER_DECISIONS = [
  "tool_call",
  "plan_update",
  "completion",
  "stop",
] as const satisfies readonly HelarcControllerDecisionKind[];

export const HELARC_ACTION_CONTRACT_VERSION = "helarc-model-decision-v1";

export function createHelarcControllerOutputFormat(
  exposure: Pick<ToolExposureProof, "contentRevision" | "catalog">,
): StructuredOutputFormat {
  const toolNames = exposure.catalog.tools.map(({ name }) => name);
  if (new Set(toolNames).size !== toolNames.length) {
    throw new TypeError("Helarc Controller output format requires unique exposed Tool names.");
  }
  const outputFormat = snapshotModelOutputFormat({
    kind: "json_schema",
    name: "helarc_model_decision",
    schemaId: "helarc.model-decision",
    schemaRevision: `${HELARC_ACTION_CONTRACT_VERSION}:${exposure.contentRevision}`,
    schema: {
      oneOf: [
        ...exposure.catalog.tools.map((tool) => ({
          type: "object",
          properties: {
            kind: { type: "string", enum: ["tool_call"] },
            toolName: { type: "string", enum: [tool.name] },
            input: tool.inputSchema,
            reason: { type: "string", minLength: 1, maxLength: 4_096 },
          },
          required: ["kind", "toolName", "input"],
          additionalProperties: false,
        })),
        {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["plan_update"] },
            plan: {
              type: "array",
              minItems: 1,
              maxItems: 64,
              items: {
                type: "object",
                properties: {
                  step: { type: "string", minLength: 1, maxLength: 4_096 },
                  status: {
                    type: "string",
                    enum: ["pending", "in_progress", "completed"],
                  },
                },
                required: ["step", "status"],
                additionalProperties: false,
              },
            },
            explanation: { type: "string", minLength: 1, maxLength: 4_096 },
          },
          required: ["kind", "plan"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["completion"] },
            summary: { type: "string", minLength: 1, maxLength: 64_000 },
          },
          required: ["kind", "summary"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["stop"] },
            reason: { type: "string", minLength: 1, maxLength: 4_096 },
          },
          required: ["kind", "reason"],
          additionalProperties: false,
        },
      ],
    },
  });
  if (outputFormat.kind !== "json_schema") {
    throw new TypeError("Helarc Controller requires structured generation.");
  }
  return outputFormat;
}

const HELARC_DECISION_DESCRIPTIONS: HelarcControllerDecisionDescription[] = [
  {
    kind: "tool_call",
    purpose: "Request one Tool execution from the active Tool catalog.",
    requiredFields: ["kind", "toolName", "input"],
    optionalFields: ["reason"],
    constraints: [
      "toolName must exactly match one Tool in the active Tool catalog",
      "input must be an object satisfying that Tool's published input JSON Schema",
    ],
  },
  {
    kind: "plan_update",
    purpose: "Create or revise the current task plan when planning improves execution.",
    requiredFields: ["kind", "plan"],
    optionalFields: ["explanation"],
    constraints: [
      "plan must be a non-empty array of objects with non-empty step and status pending, in_progress, or completed",
      "at most one Plan step may use status in_progress",
    ],
  },
  {
    kind: "completion",
    purpose: "Finish the task after the requested result is established.",
    requiredFields: ["kind", "summary"],
    optionalFields: [],
    constraints: ["summary must be a non-empty string"],
  },
  {
    kind: "stop",
    purpose: "Stop safely when the task cannot continue.",
    requiredFields: ["kind", "reason"],
    optionalFields: [],
    constraints: ["reason must be a non-empty string"],
  },
];

const HELARC_ACTION_DECISION_RULES: HelarcActionDecisionRule[] = [
  {
    id: "plan_when_useful",
    text: "Use plan_update only when an explicit plan improves the current work; simple tasks may proceed without a plan.",
  },
  {
    id: "complete_when_established",
    text: "Use completion only when the requested result is established from current Context.",
  },
  {
    id: "stop_when_blocked",
    text: "Use stop when the task cannot continue safely or meaningfully.",
  },
];

export function createHelarcActionContract(
  exposedToolNames: readonly string[],
): HelarcActionContract {
  const toolNames = snapshotToolNames(exposedToolNames);
  const inspectionNames = ["Read", "Glob", "Grep"].filter((name) => toolNames.has(name));
  const fileChangeNames = ["Edit", "Write"].filter((name) => toolNames.has(name));
  const toolRules: HelarcActionDecisionRule[] = toolNames.size === 0
    ? []
    : [
        {
          id: "active_tool_catalog_only",
          text: "Use tool_call only for Tools listed in the active Tool catalog.",
        },
        ...(inspectionNames.length === 0 ? [] : [{
          id: "inspect_before_effect",
          text: `Use ${inspectionNames.join(", ")} to establish the current Workspace state needed for an exact change.`,
        }]),
        ...(toolNames.has("Edit") ? [{
          id: "edit_exact_text",
          text: "Use Edit for exact old-to-new text replacement in an existing file.",
        }] : []),
        ...(toolNames.has("Write") ? [{
          id: "write_complete_content",
          text: "Use Write to create a file or replace its complete content.",
        }] : []),
        ...(fileChangeNames.length === 0 ? [] : [{
          id: "continue_after_file_change",
          text: `A successful ${fileChangeNames.join(" or ")} is an Observation, not task completion; continue until the requested task is complete.`,
        }]),
      ];
  return {
    decisions: HELARC_DECISION_DESCRIPTIONS
      .filter((decision) => decision.kind !== "tool_call" || toolNames.size > 0)
      .map((decision) => ({
      ...decision,
      requiredFields: [...decision.requiredFields],
      optionalFields: [...decision.optionalFields],
      constraints: [...decision.constraints],
    })),
    decisionRules: [...toolRules, ...HELARC_ACTION_DECISION_RULES].map((rule) => ({ ...rule })),
  };
}

export function buildHelarcActionProtocolText(
  contract: HelarcActionContract,
): string {
  return [
    `Return exactly one decision with kind: ${contract.decisions.map((item) => item.kind).join(", ")}.`,
    ...contract.decisions.map(formatDecisionDescription),
  ].join("\n");
}

export function buildHelarcActionDecisionRulesText(
  contract: HelarcActionContract,
): string {
  return contract.decisionRules.map((rule) => rule.text).join("\n");
}

function snapshotToolNames(input: readonly string[]): ReadonlySet<string> {
  if (!Array.isArray(input)) throw new TypeError("Exposed Tool names must be an array.");
  const names = input.map((name) => {
    if (typeof name !== "string" || name.length === 0 || name !== name.trim()) {
      throw new TypeError("Exposed Tool name is invalid.");
    }
    return name;
  });
  if (new Set(names).size !== names.length) {
    throw new TypeError("Exposed Tool names must be unique.");
  }
  return new Set(names);
}

function formatDecisionDescription(decision: HelarcControllerDecisionDescription): string {
  const required = decision.requiredFields.join(", ");
  const optional = decision.optionalFields.length > 0
    ? `, and optional ${decision.optionalFields.join(", ")}`
    : "";
  return [
    `For ${decision.kind}, return ${required}${optional}.`,
    ...decision.constraints.map((constraint) => `- ${constraint}.`),
  ].join("\n");
}

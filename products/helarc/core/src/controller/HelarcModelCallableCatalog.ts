import { createHash } from "node:crypto";
import {
  modelCallableDefinitionsContentDigest,
  snapshotModelCallableDefinitions,
  type ModelCallableDefinition,
  type ModelJsonSchema,
} from "@agent-anything/model-interaction";
import type { PlanLimits } from "@agent-anything/agent-runtime/plan";
import type { ToolRevisionRef } from "@agent-anything/tools/identity";
import type { ToolExposureProof } from "@agent-anything/tools/selection";

export const HELARC_CONTROLLER_CONTROL_SET_REVISION =
  "helarc.controller-controls.v1";
export const HELARC_STOP_REASON_MAX_LENGTH = 4_096;

export type HelarcModelCallableBinding =
  | {
      readonly kind: "tool";
      readonly callableName: string;
      readonly toolName: string;
      readonly tool: ToolRevisionRef;
    }
  | {
      readonly kind: "control";
      readonly callableName: "update_plan" | "stop";
      readonly control: "update_plan" | "stop";
    };

export interface HelarcModelCallableCatalog {
  readonly revision: string;
  readonly toolExposureProofId: string;
  readonly toolExposureContentRevision: string;
  readonly controlSetRevision: typeof HELARC_CONTROLLER_CONTROL_SET_REVISION;
  readonly definitions: readonly ModelCallableDefinition[];
  readonly bindings: readonly HelarcModelCallableBinding[];
}

export function createHelarcModelCallableCatalog(input: {
  readonly toolExposure: ToolExposureProof;
  readonly planLimits: PlanLimits;
}): HelarcModelCallableCatalog {
  const toolBindings: HelarcModelCallableBinding[] = input.toolExposure.catalog.tools.map(
    (tool) => Object.freeze({
      kind: "tool" as const,
      callableName: portableToolCallableName(tool.name, tool.fingerprint),
      toolName: tool.name,
      tool: tool.ref,
    }),
  );
  const controlBindings: readonly HelarcModelCallableBinding[] = Object.freeze([
    Object.freeze({
      kind: "control" as const,
      callableName: "stop" as const,
      control: "stop" as const,
    }),
    Object.freeze({
      kind: "control" as const,
      callableName: "update_plan" as const,
      control: "update_plan" as const,
    }),
  ]);
  const bindings = Object.freeze([...toolBindings, ...controlBindings].sort((left, right) =>
    left.callableName.localeCompare(right.callableName)
  ));
  if (new Set(bindings.map((binding) => binding.callableName)).size !== bindings.length) {
    throw new TypeError("Helarc model-callable names must be disjoint.");
  }

  const definitions = snapshotModelCallableDefinitions(bindings.map((binding) =>
    binding.kind === "tool"
      ? toolDefinition(binding, input.toolExposure)
      : controlDefinition(binding.control, input.planLimits)
  ));
  const identity = Object.freeze({
    toolExposureProofId: input.toolExposure.id,
    toolExposureContentRevision: input.toolExposure.contentRevision,
    controlSetRevision: HELARC_CONTROLLER_CONTROL_SET_REVISION,
    definitionsDigest: modelCallableDefinitionsContentDigest(definitions),
    bindings,
  });
  return Object.freeze({
    revision: `sha256:${createHash("sha256")
      .update(JSON.stringify(identity), "utf8")
      .digest("hex")}`,
    toolExposureProofId: input.toolExposure.id,
    toolExposureContentRevision: input.toolExposure.contentRevision,
    controlSetRevision: HELARC_CONTROLLER_CONTROL_SET_REVISION,
    definitions,
    bindings,
  });
}

export function findHelarcModelCallableBinding(
  catalog: HelarcModelCallableCatalog,
  callableName: string,
): HelarcModelCallableBinding | undefined {
  return catalog.bindings.find((binding) => binding.callableName === callableName);
}

function toolDefinition(
  binding: Extract<HelarcModelCallableBinding, { readonly kind: "tool" }>,
  exposure: ToolExposureProof,
): ModelCallableDefinition {
  const descriptor = exposure.catalog.tools.find((tool) =>
    tool.name === binding.toolName &&
    tool.ref.revision === binding.tool.revision &&
    tool.ref.tool.namespace === binding.tool.tool.namespace &&
    tool.ref.tool.name === binding.tool.tool.name
  );
  if (descriptor === undefined) {
    throw new TypeError("Helarc callable binding does not match current Tool Exposure.");
  }
  return Object.freeze({
    name: binding.callableName,
    description: descriptor.description ?? `Invoke the exposed ${descriptor.name} Tool.`,
    inputSchema: descriptor.inputSchema as ModelJsonSchema,
  });
}

function controlDefinition(
  control: "update_plan" | "stop",
  limits: PlanLimits,
): ModelCallableDefinition {
  if (control === "stop") {
    return Object.freeze({
      name: "stop",
      description: "Stop when the task cannot be completed safely or requires unavailable information.",
      inputSchema: Object.freeze({
        type: "object",
        properties: Object.freeze({
          reason: Object.freeze({
            type: "string",
            minLength: 1,
            maxLength: HELARC_STOP_REASON_MAX_LENGTH,
          }),
        }),
        required: Object.freeze(["reason"]),
        additionalProperties: false,
      }),
    });
  }
  return Object.freeze({
    name: "update_plan",
    description: "Create or revise the current Run plan when an explicit plan helps the work.",
    inputSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({
        explanation: Object.freeze({
          type: "string",
          maxLength: limits.maxExplanationLength,
        }),
        plan: Object.freeze({
          type: "array",
          minItems: 1,
          maxItems: limits.maxSteps,
          items: Object.freeze({
            type: "object",
            properties: Object.freeze({
              step: Object.freeze({
                type: "string",
                minLength: 1,
                maxLength: limits.maxStepLength,
              }),
              status: Object.freeze({
                type: "string",
                enum: Object.freeze(["pending", "in_progress", "completed"]),
              }),
            }),
            required: Object.freeze(["step", "status"]),
            additionalProperties: false,
          }),
        }),
      }),
      required: Object.freeze(["plan"]),
      additionalProperties: false,
    }),
  });
}

function portableToolCallableName(name: string, fingerprint: string): string {
  const stem = name.replace(/[^A-Za-z0-9_-]/gu, "_").replace(/_+/gu, "_")
    .replace(/^_+|_+$/gu, "").slice(0, 42) || "tool";
  const digest = createHash("sha256")
    .update(`${name}\u0000${fingerprint}`, "utf8")
    .digest("hex")
    .slice(0, 12);
  return `tool_${stem}_${digest}`;
}

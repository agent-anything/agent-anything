import { createHash } from "node:crypto";
import {
  modelCallableDefinitionsContentDigest,
  snapshotModelCallableDefinitions,
  type ModelCallableDefinition,
  type ModelJsonSchema,
} from "@agent-anything/model-interaction";
import type { PlanLimits } from "@agent-anything/agent-runtime/plan";
import { toolRevisionKey, type ToolRevisionRef } from "@agent-anything/tools/identity";
import type { ToolExposureProof } from "@agent-anything/tools/selection";
import type { ResolvedHelarcToolGuidance } from "../tools/guidance/index.js";
import {
  createHelarcControllerControlDefinitions,
  type HelarcControllerControlGuidance,
} from "./HelarcControllerControlGuidance.js";

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
  readonly definitionsDigest: string;
  readonly toolExposureProofId: string;
  readonly toolExposureContentRevision: string;
  readonly toolGuidanceId: string;
  readonly toolGuidanceContentDigest: string;
  readonly controlGuidanceRevision: string;
  readonly definitions: readonly ModelCallableDefinition[];
  readonly bindings: readonly HelarcModelCallableBinding[];
}

export function createHelarcModelCallableCatalog(input: {
  readonly toolExposure: ToolExposureProof;
  readonly toolGuidance: ResolvedHelarcToolGuidance;
  readonly controlGuidance: HelarcControllerControlGuidance;
  readonly planLimits: PlanLimits;
}): HelarcModelCallableCatalog {
  if (
    input.toolExposure.selectionRevision !==
      input.toolGuidance.toolSelection.toolSelectionRevision
  ) {
    throw new TypeError("Helarc Tool Exposure and Tool Guidance target different Tool Selections.");
  }
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
    left.callableName < right.callableName
      ? -1
      : left.callableName > right.callableName
      ? 1
      : 0
  ));
  if (new Set(bindings.map((binding) => binding.callableName)).size !== bindings.length) {
    throw new TypeError("Helarc model-callable names must be disjoint.");
  }

  const controlDefinitions = new Map(
    createHelarcControllerControlDefinitions(input.controlGuidance, input.planLimits)
      .map((definition) => [definition.name, definition]),
  );
  const definitions = snapshotModelCallableDefinitions(bindings.map((binding) => {
    if (binding.kind === "tool") {
      return toolDefinition(binding, input.toolExposure, input.toolGuidance);
    }
    const definition = controlDefinitions.get(binding.control);
    if (definition === undefined) {
      throw new TypeError(`Helarc Controller Control Guidance is missing '${binding.control}'.`);
    }
    return definition;
  }));
  const definitionsDigest = modelCallableDefinitionsContentDigest(definitions);
  const identity = Object.freeze({
    toolExposureProofId: input.toolExposure.id,
    toolExposureContentRevision: input.toolExposure.contentRevision,
    toolGuidanceId: input.toolGuidance.id,
    toolGuidanceContentDigest: input.toolGuidance.contentDigest,
    controlGuidanceRevision: input.controlGuidance.revision,
    definitionsDigest,
    bindings,
  });
  return Object.freeze({
    revision: `sha256:${createHash("sha256")
      .update(JSON.stringify(identity), "utf8")
      .digest("hex")}`,
    definitionsDigest,
    toolExposureProofId: input.toolExposure.id,
    toolExposureContentRevision: input.toolExposure.contentRevision,
    toolGuidanceId: input.toolGuidance.id,
    toolGuidanceContentDigest: input.toolGuidance.contentDigest,
    controlGuidanceRevision: input.controlGuidance.revision,
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
  guidance: ResolvedHelarcToolGuidance,
): ModelCallableDefinition {
  const descriptor = exposure.catalog.tools.find((tool) =>
    tool.name === binding.toolName && toolRevisionKey(tool.ref) === toolRevisionKey(binding.tool)
  );
  if (descriptor === undefined) {
    throw new TypeError("Helarc callable binding does not match current Tool Exposure.");
  }
  const entry = guidance.entries.find(({ tool }) =>
    toolRevisionKey(tool) === toolRevisionKey(descriptor.ref)
  );
  if (entry === undefined) {
    throw new TypeError(`Helarc Tool Guidance is missing '${toolRevisionKey(descriptor.ref)}'.`);
  }
  if (
    entry.name !== descriptor.name ||
    entry.descriptorFingerprint !== descriptor.fingerprint
  ) {
    throw new TypeError(`Helarc Tool Guidance does not match '${toolRevisionKey(descriptor.ref)}'.`);
  }
  return Object.freeze({
    name: binding.callableName,
    description: entry.modelDescription,
    inputSchema: entry.inputSchema as ModelJsonSchema,
  });
}

function portableToolCallableName(name: string, fingerprint: string): string {
  const stem = name.replace(/[^A-Za-z0-9_-]/gu, "_").replace(/_+/gu, "_")
    .replace(/^_+|_+$/gu, "").slice(0, 42) || "tool";
  const digest = createHash("sha256")
    .update(`${name}\u0000${fingerprint}`, "utf8")
    .digest("hex")
    .slice(0, 12);
  return `${stem}_${digest}`;
}

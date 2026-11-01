import { createHash } from "node:crypto";
import {TaskResponseBindingError} from "@agent-anything/agent-runtime/decision";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {
  modelCallableDefinitionsContentDigest,
  snapshotModelCallableDefinitions,
  type ModelCallableDefinition,
  type ModelJsonSchema,
  type ProviderRequest,
  type ModelJsonValue,
} from "@agent-anything/model-interaction";
import type { PlanLimits } from "@agent-anything/agent-runtime/plan";
import { toolRevisionKey, type ToolRevisionRef, type ToolBindingRef } from "@agent-anything/tools/identity";
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
      readonly binding: ToolBindingRef;
    }
  | {
      readonly kind: "control";
      readonly callableName: "update_plan";
      readonly control: "update_plan";
    }
  | {
      readonly kind: "control";
      readonly callableName: "final_result";
      readonly control: "final_result";
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
  readonly hasPlan: boolean;
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
      binding: tool.binding,
    }),
  );
  const controlBindings: readonly HelarcModelCallableBinding[] = Object.freeze([
    Object.freeze({kind: "control" as const, callableName: "final_result" as const, control: "final_result" as const}),
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
    createHelarcControllerControlDefinitions(input.controlGuidance, input.planLimits, input.hasPlan)
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
    revision: modelInputValueDigest(identity),
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

/** Non-model metadata; definitions are retained once in the actual native interaction. */
export function retainHelarcCallableBinding(catalog:HelarcModelCallableCatalog):ModelJsonValue {
  const {definitions:_,...binding}=catalog;
  return JSON.parse(JSON.stringify(binding)) as ModelJsonValue;
}

export function restoreHelarcCallableCatalog(request:ProviderRequest,exposure:ToolExposureProof):HelarcModelCallableCatalog {
  const retained=request.metadata.modelCallableBinding as unknown as Omit<HelarcModelCallableCatalog,"definitions">;
  if(!retained||typeof retained!=="object"||request.interaction.kind!=="native_tool_turn")throw new TaskResponseBindingError("helarc_callable_binding_missing");
  const definitions=snapshotModelCallableDefinitions(request.interaction.callables);
  const identity={toolExposureProofId:retained.toolExposureProofId,toolExposureContentRevision:retained.toolExposureContentRevision,
    toolGuidanceId:retained.toolGuidanceId,toolGuidanceContentDigest:retained.toolGuidanceContentDigest,
    controlGuidanceRevision:retained.controlGuidanceRevision,definitionsDigest:modelCallableDefinitionsContentDigest(definitions),bindings:retained.bindings};
  const revision=modelInputValueDigest(identity);
  if(!Array.isArray(retained.bindings)||retained.revision!==revision||retained.definitionsDigest!==identity.definitionsDigest||
    request.composition.lineage.callableDefinitions?.id!==revision||request.composition.lineage.callableDefinitions?.revision!==identity.definitionsDigest||
    retained.toolExposureProofId!==exposure.id||retained.toolExposureContentRevision!==exposure.contentRevision||
    JSON.stringify(retained.bindings.map(b=>b.callableName))!==JSON.stringify(definitions.map(d=>d.name)))throw new TaskResponseBindingError("helarc_callable_binding_changed");
  for(const binding of retained.bindings) {
    if(binding.kind==="tool") {
      const tool=exposure.catalog.tools.find(t=>t.name===binding.toolName&&toolRevisionKey(t.ref)===toolRevisionKey(binding.tool));
      if(!tool||modelInputValueDigest(tool.binding)!==modelInputValueDigest(binding.binding)||portableToolCallableName(tool.name,tool.fingerprint)!==binding.callableName)
        throw new TaskResponseBindingError("helarc_callable_exposure_mismatch");
    } else if(binding.kind!=="control"||binding.control!==binding.callableName||!["update_plan","final_result"].includes(binding.control))throw new TaskResponseBindingError("helarc_callable_control_invalid");
  }
  return Object.freeze({...structuredClone(retained),definitions});
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

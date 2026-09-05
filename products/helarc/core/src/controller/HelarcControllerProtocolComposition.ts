import { createHash } from "node:crypto";
import {
  createDefaultHelarcInstructionSettings,
  snapshotHelarcInstructionSettings,
  type HelarcInstructionSectionSetting,
  type HelarcInstructionSettings,
} from "../instructions/index.js";
import type { PlanLimits } from "@agent-anything/agent-runtime/plan";
import type { RegisteredTool } from "@agent-anything/tools/registration";
import type { ToolExposureProof } from "@agent-anything/tools/selection";
import {
  createHelarcBaselineToolGuidance,
  createHelarcToolGuidanceBinding,
  resolveHelarcToolGuidance,
  type HelarcToolGuidanceBinding,
  type ResolvedHelarcToolGuidance,
} from "../tools/guidance/index.js";
import type { HelarcShellRuntimeProfile } from "../tools/HelarcBaselineToolContracts.js";
import {
  HELARC_CONTROLLER_CONTROL_GUIDANCE,
  type HelarcControllerControlGuidance,
} from "./HelarcControllerControlGuidance.js";
import {
  createHelarcModelCallableCatalog,
  type HelarcModelCallableCatalog,
} from "./HelarcModelCallableCatalog.js";

export interface HelarcControllerProtocolComposition {
  readonly protocolInstructions: readonly HelarcInstructionSectionSetting[];
  readonly id: "helarc.controller-protocol-composition";
  readonly revision: string;
  readonly toolGuidance: ResolvedHelarcToolGuidance;
  readonly controlGuidance: HelarcControllerControlGuidance;
  bindRun(runId: string): HelarcToolGuidanceBinding;
  createCallableCatalog(
    toolExposure: ToolExposureProof,
    planLimits: PlanLimits,
  ): HelarcModelCallableCatalog;
}

export function createHelarcBaselineControllerProtocolComposition(input: {
  readonly instructionSettings?: HelarcInstructionSettings;
  readonly providerId: string;
  readonly modelId: string;
  readonly toolSelectionRevision: string;
  readonly tools: readonly RegisteredTool[];
  readonly shellRuntime: HelarcShellRuntimeProfile;
}): HelarcControllerProtocolComposition {
  const baseline = createHelarcBaselineToolGuidance(input.tools, input.shellRuntime);
  return createHelarcControllerProtocolComposition({
    instructionSettings: input.instructionSettings,
    toolGuidance: resolveHelarcToolGuidance({
      catalog: baseline.catalog,
      release: baseline.release.ref,
      providerId: input.providerId,
      modelId: input.modelId,
      toolSelectionRevision: input.toolSelectionRevision,
      tools: input.tools,
    }),
    controlGuidance: HELARC_CONTROLLER_CONTROL_GUIDANCE,
  });
}

export function createHelarcControllerProtocolComposition(input: {
  readonly instructionSettings?: HelarcInstructionSettings;
  readonly toolGuidance: ResolvedHelarcToolGuidance;
  readonly controlGuidance: HelarcControllerControlGuidance;
}): HelarcControllerProtocolComposition {
  const settings = snapshotHelarcInstructionSettings(input.instructionSettings ?? createDefaultHelarcInstructionSettings());
  const material = Object.freeze({
    protocolInstructions: settings.protocol,
    id: "helarc.controller-protocol-composition" as const,
    toolGuidanceId: input.toolGuidance.id,
    toolGuidanceContentDigest: input.toolGuidance.contentDigest,
    controlGuidanceRevision: input.controlGuidance.revision,
  });
  const revision = `sha256:${createHash("sha256")
    .update(JSON.stringify(material), "utf8")
    .digest("hex")}`;
  return Object.freeze({
    protocolInstructions: settings.protocol,
    id: material.id,
    revision,
    toolGuidance: input.toolGuidance,
    controlGuidance: input.controlGuidance,
    bindRun(runId: string) {
      return createHelarcToolGuidanceBinding({ runId, guidance: input.toolGuidance });
    },
    createCallableCatalog(toolExposure: ToolExposureProof, planLimits: PlanLimits) {
      return createHelarcModelCallableCatalog({
        toolExposure,
        toolGuidance: input.toolGuidance,
        controlGuidance: input.controlGuidance,
        planLimits,
      });
    },
  });
}

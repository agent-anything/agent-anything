import { createHelarcAgent, createHelarcDelegatedWorkerAgent } from "../agent/HelarcAgent.js";
import { createHelarcDescendantAgentContribution } from "../agent/HelarcDescendantAgent.js";
import { createHelarcClarificationContribution } from "../interaction/index.js";
import { createHelarcToolProfile } from "../composition/HelarcActionComposition.js";
import { resolveHelarcModelQualification } from "../composition/HelarcModelUseAdmission.js";
import { createHelarcBaselineControllerProtocolComposition } from "../controller/HelarcControllerProtocolComposition.js";
import { createToolBindingAvailabilityAssessment, createToolExposureProof, resolveCurrentTurnToolExposure } from "@agent-anything/tools/selection";
import type { Provider } from "@agent-anything/model-interaction";
import type { HelarcProviderProfile } from "../configuration/HelarcProviderProfile.js";
import type { HelarcInstructionSettings } from "../instructions/index.js";
import type { HelarcShellRuntimeProfile } from "../tools/HelarcBaselineToolContracts.js";
import type { HelarcModelQualificationCatalog } from "../model-qualification/HelarcModelQualification.js";
import type { CodeFileActionAdapterIds } from "@agent-anything/helarc-code-agent/file-operation";

export interface HelarcQualificationProfileInput {
  readonly planLimits: import("@agent-anything/agent-runtime/plan").PlanLimits;
  readonly provider: Provider;
  readonly providerProfile: HelarcProviderProfile;
  readonly instructionSettings: HelarcInstructionSettings;
  readonly shellRuntime: HelarcShellRuntimeProfile;
  readonly fileActionAdapterIds: CodeFileActionAdapterIds;
  readonly shellActionAdapterId: string;
  readonly taskStopActionAdapterId: string;
}

export function createHelarcQualificationProfile(input: HelarcQualificationProfileInput, catalog?: HelarcModelQualificationCatalog) {
  const providerId = input.provider.descriptor.id;
  const modelId = input.provider.modelContext.target.model;
  const instructionSettings = input.instructionSettings;
  const agent = createHelarcAgent({ providerId, modelId, instructionSettings, target: "production" });
  const delegated = createHelarcDelegatedWorkerAgent({ providerId, modelId, instructionSettings });
  const admittedAt = "2026-01-01T00:00:00.000Z";
  const tools = createHelarcToolProfile({
    admittedAt,
    file: { actionAdapterIds: input.fileActionAdapterIds },
    command: { ...input, shellTool: input.shellRuntime.toolName },
    semanticTools: [createHelarcClarificationContribution(admittedAt).tool,
      ...createHelarcDescendantAgentContribution(delegated, admittedAt).tools],
  });
  const protocol = createHelarcBaselineControllerProtocolComposition({
    providerId, modelId, instructionSettings, shellRuntime: input.shellRuntime,
    toolSelectionRevision: tools.toolSelection.revision,
    tools: tools.toolSelection.tools.map(({ registration }) => registration),
  });
  const qualification = resolveHelarcModelQualification({
    provider: input.provider, providerProfile: input.providerProfile, agent,
    controllerProtocol: protocol, catalog,
  });
  const basisRefs = [{ owner: "helarc", kind: "qualification_fixture", id: "baseline", revision: "1" }];
  const exposure = resolveCurrentTurnToolExposure(tools.toolSelection, {
    basisRefs,
    assessments: tools.toolSelection.tools.map(({ registration }) => createToolBindingAvailabilityAssessment({
      selection: tools.toolSelection, tool: registration.descriptor.ref, basisRefs,
      disposition: "available", reason: null,
    })),
  });
  const callables = protocol.createCallableCatalog(createToolExposureProof(exposure, "qualification"), input.planLimits, false);
  return { agent, protocol, qualification, callables, tools: exposure.catalog.tools, shellRuntime: input.shellRuntime,
    planLimits: Object.freeze({ ...input.planLimits }) };
}

export type HelarcQualificationProfile = ReturnType<typeof createHelarcQualificationProfile>;

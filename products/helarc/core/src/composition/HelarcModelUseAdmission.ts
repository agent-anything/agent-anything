import { createHash } from "node:crypto";
import type { Agent } from "@agent-anything/agent-core/agent";
import type { Provider } from "@agent-anything/model-interaction";
import type { HelarcProviderProfile } from "../configuration/HelarcProviderProfile.js";
import {
  HELARC_NATIVE_TOOL_PROTOCOL_REVISION,
  type HelarcAgentOutput,
} from "../controller/HelarcController.js";
import type {
  HelarcControllerProtocolComposition,
} from "../controller/HelarcControllerProtocolComposition.js";
import type { HelarcBaselineToolName } from "../tools/HelarcBaselineToolContracts.js";
import { HELARC_MODEL_QUALIFICATION_CATALOG } from "../model-qualification/HelarcModelQualificationCatalog.js";
import {
  HELARC_MODEL_QUALIFICATION_PROTOCOL_REVISION,
  HELARC_MODEL_QUALIFICATION_SCOPES,
  createHelarcModelQualificationTarget,
  deriveHelarcModelUseDisposition,
  projectHelarcModelQualificationSafe,
  type HelarcModelQualificationCatalog,
  type HelarcModelQualificationSafeProjection,
  type HelarcModelQualificationResolution,
  type HelarcModelQualificationScope,
} from "../model-qualification/HelarcModelQualification.js";

export const HELARC_PRODUCT_REVISION = "helarc.product.v1";
export const HELARC_OPERATING_PROFILE_REVISION = "helarc.operating-profile.v1";

export type HelarcModelUseAdmissionErrorCode =
  | "model_native_tool_interaction_unsupported"
  | "model_qualification_required"
  | "model_qualification_not_qualified";

export class HelarcModelUseAdmissionError extends Error {
  constructor(
    readonly code: HelarcModelUseAdmissionErrorCode,
    message: string,
    readonly qualification: HelarcModelQualificationSafeProjection,
  ) {
    super(message);
    this.name = "HelarcModelUseAdmissionError";
  }
}

export function resolveHelarcModelQualification(input: {
  readonly provider: Provider;
  readonly providerProfile: HelarcProviderProfile;
  readonly agent: Agent<HelarcAgentOutput>;
  readonly controllerProtocol: HelarcControllerProtocolComposition;
  readonly catalog?: HelarcModelQualificationCatalog;
  readonly operatingProfileRevision?: string;
}): HelarcModelQualificationResolution {
  assertProviderProfileIdentity(input.provider, input.providerProfile);
  const catalog = input.catalog ?? HELARC_MODEL_QUALIFICATION_CATALOG;
  const requiredScopes = requiredScopesForTools(
    input.controllerProtocol.toolGuidance.entries.map(({ name }) => name),
  );
  const target = createHelarcModelQualificationTarget({
    productRevision: HELARC_PRODUCT_REVISION,
    providerKind: input.providerProfile.providerKind,
    providerAdapterRevision: providerAdapterRevision(
      input.provider,
      input.providerProfile.providerKind,
    ),
    providerCapabilityDigest: digest(
      "agent-anything.helarc.provider-capabilities.v1",
      input.provider.descriptor.capabilities,
    ),
    endpointCompatibilityFamily: endpointCompatibilityFamily(
      input.providerProfile.providerKind,
    ),
    safeProviderConfigurationDigest: digest(
      "agent-anything.helarc.safe-provider-configuration.v1",
      {
        providerKind: input.providerProfile.providerKind,
        baseUrl: input.providerProfile.baseUrl,
        model: input.providerProfile.model,
        timeoutMs: input.providerProfile.timeoutMs,
      },
    ),
    modelId: input.providerProfile.model,
    modelArtifactRevision: null,
    modelIdentityStrength: "unknown",
    modelRuntimeRevision: null,
    generationConfigurationDigest: digest(
      "agent-anything.helarc.generation-configuration.v1",
      {
        providerKind: input.providerProfile.providerKind,
        model: input.providerProfile.model,
        generationPolicy: "provider-defaults.v1",
      },
    ),
    agentInstructionBinding: digest(
      "agent-anything.helarc.agent-instruction-binding.v1",
      {
        agent: { id: input.agent.id, revision: input.agent.revision },
        instructions: input.agent.instructions.ref,
        release: input.agent.instructions.release,
        resolverRevision: input.agent.instructions.resolverRevision,
        contentDigest: input.agent.instructions.contentDigest,
        model: input.agent.instructions.model,
      },
    ),
    toolGuidanceBinding: digest(
      "agent-anything.helarc.tool-guidance-target-binding.v1",
      {
        id: input.controllerProtocol.toolGuidance.id,
        release: input.controllerProtocol.toolGuidance.release,
        profileRevision:
          input.controllerProtocol.toolGuidance.guidanceProfileRevision,
        contentDigest: input.controllerProtocol.toolGuidance.contentDigest,
      },
    ),
    toolSelectionRevision:
      input.controllerProtocol.toolGuidance.toolSelection.toolSelectionRevision,
    modelInteractionRevision: HELARC_NATIVE_TOOL_PROTOCOL_REVISION,
    operatingProfileRevision:
      input.operatingProfileRevision ?? HELARC_OPERATING_PROFILE_REVISION,
    qualificationProtocolRevision: HELARC_MODEL_QUALIFICATION_PROTOCOL_REVISION,
  });
  const disposition = deriveHelarcModelUseDisposition({
    catalog,
    target,
    nativeToolInteractionSupported:
      input.provider.descriptor.capabilities.nativeToolInteraction.supported,
    requiredScopes,
    policy: input.providerProfile.qualificationPolicy,
  });
  const safeProjection = projectHelarcModelQualificationSafe({
    catalog,
    target,
    disposition,
    toolGuidance: {
      releaseId: input.controllerProtocol.toolGuidance.release.id,
      releaseRevision: input.controllerProtocol.toolGuidance.release.revision,
      profileRevision:
        input.controllerProtocol.toolGuidance.guidanceProfileRevision,
    },
  });
  return Object.freeze({ target, disposition, safeProjection, requiredScopes });
}

export function admitHelarcModelUse(
  qualification: HelarcModelQualificationResolution,
): void {
  if (qualification.disposition.status !== "blocked") return;
  if (!qualification.disposition.nativeToolInteractionSupported) {
    throw new HelarcModelUseAdmissionError(
      "model_native_tool_interaction_unsupported",
      "The configured Provider does not support the native Tool interaction required by Helarc.",
      qualification.safeProjection,
    );
  }
  if (qualification.disposition.reasons.some((reason) =>
    reason.startsWith("scope_not_qualified:")
  )) {
    throw new HelarcModelUseAdmissionError(
      "model_qualification_not_qualified",
      "The configured model is not qualified for the requested Helarc Tool profile.",
      qualification.safeProjection,
    );
  }
  throw new HelarcModelUseAdmissionError(
    "model_qualification_required",
    "The configured model lacks current qualification for the requested Helarc Tool profile.",
    qualification.safeProjection,
  );
}

function requiredScopesForTools(
  names: readonly string[],
): readonly HelarcModelQualificationScope[] {
  const scopes = new Set<HelarcModelQualificationScope>(["agent_loop"]);
  for (const name of names) {
    const scope = TOOL_SCOPE[name as HelarcBaselineToolName];
    if (scope === undefined) {
      throw new TypeError(`Helarc qualification does not recognize Tool '${name}'.`);
    }
    scopes.add(scope);
  }
  return Object.freeze(HELARC_MODEL_QUALIFICATION_SCOPES.filter((scope) =>
    scopes.has(scope)
  ));
}

function assertProviderProfileIdentity(
  provider: Provider,
  profile: HelarcProviderProfile,
): void {
  if (
    provider.modelContext.target.providerId !== provider.descriptor.id ||
    provider.modelContext.target.model !== profile.model ||
    (providerKindForDescriptor(provider.descriptor.id) !== null &&
      providerKindForDescriptor(provider.descriptor.id) !== profile.providerKind)
  ) {
    throw new TypeError(
      "Helarc Provider profile, descriptor, and model-target identities differ.",
    );
  }
}

function providerKindForDescriptor(
  id: string,
): HelarcProviderProfile["providerKind"] | null {
  if (id === "openai-compatible.chat-completions") return "openai-compatible";
  if (id === "ollama.api") return "ollama";
  return null;
}

function providerAdapterRevision(
  provider: Provider,
  kind: HelarcProviderProfile["providerKind"],
): string {
  return digest("agent-anything.helarc.provider-adapter.v1", {
    kind,
    providerId: provider.descriptor.id,
    requestRetryScheduler: provider.descriptor.requestRetryScheduler,
    modelTarget: provider.modelContext.target,
    contextCapacity: provider.modelContext.capacity,
    requestedOutput: provider.modelContext.requestedOutput,
    inputPreservation: provider.modelContext.inputPreservation,
    requestBodyTransportLimit: provider.requestBodyTransportLimit,
  });
}

function endpointCompatibilityFamily(
  kind: HelarcProviderProfile["providerKind"],
): string {
  return kind === "ollama"
    ? "ollama.api.v1"
    : "openai-compatible.chat-completions.v1";
}

function digest(domain: string, value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(canonicalJson(value), "utf8")
    .digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Qualification digest input is invalid.");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    ).join(",")}}`;
  }
  throw new TypeError("Qualification digest input is invalid.");
}

const TOOL_SCOPE: Readonly<Record<HelarcBaselineToolName, HelarcModelQualificationScope>> =
  Object.freeze({
    Read: "workspace_observation",
    Glob: "workspace_observation",
    Grep: "workspace_observation",
    Edit: "workspace_mutation",
    Write: "workspace_mutation",
    Bash: "process_execution",
    PowerShell: "process_execution",
    TaskStop: "process_execution",
    AskUserQuestion: "user_interaction",
    Agent: "delegation",
    SendMessage: "delegation",
  });

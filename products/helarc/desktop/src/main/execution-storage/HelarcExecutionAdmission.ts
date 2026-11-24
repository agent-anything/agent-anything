import type { RunInputItem } from "@agent-anything/agent-core/input";
import type { IdentityRef } from "@agent-anything/agent-core/run";
import type { AgentTask } from "@agent-anything/agent-core/task";
import type { RunLimits, RunTreeLimits } from "@agent-anything/agent-runtime/execution-coordinator";
import type { HelarcInstructionSettings, HelarcProviderProfile, HelarcPermissionPreset } from "@agent-anything/helarc/configuration";
import type { HelarcTaskInput } from "@agent-anything/helarc/task";
import type { CodeAgentCommandLimits } from "@agent-anything/helarc-local-environment/command";
import type { Provider } from "@agent-anything/model-interaction";
import type { WorkspaceSelection } from "@agent-anything/workspace/selection";
import type { SandboxEnforcement } from "@agent-anything/action-execution/sandbox";
import type {RetainedCommandEnvironment} from "./ExecutionEnvironmentProtection.js";

/** Original Product composition, with command environment sealed by the Host. Never executable services. */
interface HelarcExecutionAdmissionBase {
  readonly productStart?: import("@agent-anything/helarc/work-context").HelarcRunStartCommit;
  readonly conversationHandoff?: import("../run/HelarcConversationHandoff.js").HelarcConversationHandoff & {
    readonly recipientAgent: import("@agent-anything/agent-core/agent").AgentDefinitionRevisionRef;
  };
  readonly rootRunId: string;
  readonly productRunId: string;
  readonly sessionId: string;
  readonly createdAt: string;
  readonly task: AgentTask<HelarcTaskInput>;
  readonly inputItems: readonly RunInputItem[];
  readonly workspace: WorkspaceSelection;
  readonly identity: IdentityRef;
  readonly instructionSettings: HelarcInstructionSettings;
  readonly permissionPreset: HelarcPermissionPreset;
  readonly enforcement: SandboxEnforcement;
  readonly commandLimits: Partial<CodeAgentCommandLimits> | null;
  readonly runLimits: RunLimits;
  readonly runTreeLimits: RunTreeLimits;
  readonly responseDelivery: "buffered" | "streaming";
  readonly environmentFingerprint: string;
  readonly commandEnvironment: RetainedCommandEnvironment;
  readonly executionBindings: import("@agent-anything/canonical-action/subject").SerializableValue;
}
/** Historical generic composition. Its fields must not be synthesized for native work. */
export interface HelarcLegacyExecutionAdmission extends HelarcExecutionAdmissionBase {
  readonly version:3;
  readonly providerProfile:HelarcProviderProfile;
  readonly providerBinding:HelarcProviderRecoveryBinding;
  readonly providerCredential:import("../provider/HelarcRunCredentialBinding.js").HelarcRunCredentialBinding;
  readonly contextBinding:import("../context/HelarcContextRunBinding.js").RetainedContextRunBinding;
}
export interface HelarcNativeExecutionAdmission extends HelarcExecutionAdmissionBase {
  readonly version:4;
  readonly model:{
    readonly configuration:import("../../shared/ProviderConfiguration.js").ProviderConfiguration;
    readonly connection:import("../provider/ProviderConnectionRetention.js").RetainedConnection;
    readonly root:import("@agent-anything/model-interaction/protocol").ModelAgentCompositionBinding;
    readonly delegated:import("@agent-anything/model-interaction/protocol").ModelAgentCompositionBinding;
  };
  readonly contextBinding:import("../context/HelarcNativeContextRunBinding.js").RetainedNativeContextRunBinding;
}
export type HelarcExecutionAdmission=HelarcLegacyExecutionAdmission|HelarcNativeExecutionAdmission;

export interface HelarcProviderRecoveryBinding {
  readonly descriptor: Provider["descriptor"];
  readonly modelContext: Omit<Provider["modelContext"], "measure" | "measureAsync" | "accounting"> & {
    readonly accounting?: Omit<NonNullable<Provider["modelContext"]["accounting"]>, "project">;
  };
}

export function retainHelarcProviderBinding(provider: Provider): HelarcProviderRecoveryBinding {
  const {target, capacity, requestedOutput, inputPreservation, accounting} = provider.modelContext;
  const facts = accounting ? {basis: accounting.basis, inputUsage: accounting.inputUsage, outputUsage: accounting.outputUsage,
    defaultGenerationRoom: accounting.defaultGenerationRoom, limitations: accounting.limitations,
    ...(accounting.evidence ? {evidence: accounting.evidence} : {})} : null;
  return {descriptor: provider.descriptor, modelContext: {target, capacity, requestedOutput, inputPreservation,
    ...(facts ? {accounting: facts} : {})}};
}

export interface HelarcExecutionDiscovery {
  readonly admitted: boolean;
  readonly admission: HelarcExecutionAdmission;
  readonly terminal: boolean;
  readonly delivered: boolean;
  readonly revision: number;
}

export interface ProductWorkSummary extends Omit<HelarcExecutionDiscovery,"admission"> {
  readonly rootRunId:string;
  readonly productRunId:string;
  readonly sessionId:string;
  readonly title:string;
  readonly resumeLimitation:import("../../shared/HelarcExecutionRecovery.js").RecoveryBindingLimitation|null;
}

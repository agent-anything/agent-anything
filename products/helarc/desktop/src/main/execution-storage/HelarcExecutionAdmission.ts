import type { RunInputItem } from "@agent-anything/agent-core/input";
import type { IdentityRef } from "@agent-anything/agent-core/run";
import type { AgentTask } from "@agent-anything/agent-core/task";
import type { RunLimits, RunTreeLimits } from "@agent-anything/agent-runtime/runner";
import type { HelarcInstructionSettings, HelarcProviderProfile, HelarcPermissionPreset } from "@agent-anything/helarc/configuration";
import type { HelarcModelQualificationCatalog, HelarcModelQualificationSafeProjection } from "@agent-anything/helarc/model-qualification";
import type { HelarcTaskInput } from "@agent-anything/helarc/task";
import type { CodeAgentCommandLimits } from "@agent-anything/helarc-local-environment/command";
import type { Provider } from "@agent-anything/model-interaction";
import type { WorkspaceSelection } from "@agent-anything/workspace/selection";
import type { SandboxEnforcement } from "@agent-anything/action-execution/sandbox";

/** Original Product composition data, never credentials or executable services. */
export interface HelarcExecutionAdmission {
  readonly version: 1;
  readonly rootRunId: string;
  readonly productRunId: string;
  readonly sessionId: string;
  readonly createdAt: string;
  readonly task: AgentTask<HelarcTaskInput>;
  readonly inputItems: readonly RunInputItem[];
  readonly workspace: WorkspaceSelection;
  readonly identity: IdentityRef;
  readonly providerProfile: HelarcProviderProfile;
  readonly providerBinding: HelarcProviderRecoveryBinding;
  readonly instructionSettings: HelarcInstructionSettings;
  readonly qualificationCatalog: HelarcModelQualificationCatalog | null;
  readonly qualification: HelarcModelQualificationSafeProjection;
  readonly permissionPreset: HelarcPermissionPreset;
  readonly enforcement: SandboxEnforcement;
  readonly commandLimits: Partial<CodeAgentCommandLimits> | null;
  readonly runLimits: RunLimits;
  readonly runTreeLimits: RunTreeLimits;
  readonly responseDelivery: "buffered" | "streaming";
  readonly environmentFingerprint: string;
}

export interface HelarcProviderRecoveryBinding {
  readonly descriptor: Provider["descriptor"];
  readonly modelContext: Omit<Provider["modelContext"], "measure">;
}

export function retainHelarcProviderBinding(provider: Provider): HelarcProviderRecoveryBinding {
  const {target, capacity, requestedOutput, inputPreservation} = provider.modelContext;
  return {descriptor: provider.descriptor, modelContext: {target, capacity, requestedOutput, inputPreservation}};
}

export interface HelarcExecutionDiscovery {
  readonly admission: HelarcExecutionAdmission;
  readonly terminal: boolean;
  readonly delivered: boolean;
  readonly revision: number;
}

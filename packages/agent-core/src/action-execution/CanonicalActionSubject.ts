import type { CanonicalAdditionalPermissions } from "@agent-anything/permission/approval";
import type { ActionEffectSet } from "./CapabilityEffect.js";
import type { CanonicalActionOperation } from "./CanonicalActionOperation.js";
import type {
  CanonicalActorIdentity,
  CanonicalEnvironmentIdentity,
  CanonicalWorkspaceIdentity,
} from "./CanonicalIdentity.js";
import type { TargetStateAssertion } from "./TargetStateAssertion.js";

export interface CanonicalAdapterRegistrationIdentity {
  readonly id: string;
  readonly version: string;
  readonly inputSchemaVersion: string;
  readonly registrationFingerprint: string;
}

export interface CanonicalExecutorRegistrationIdentity {
  readonly id: string;
  readonly version: string;
  readonly invocationContractVersion: string;
  readonly registrationFingerprint: string;
}

export interface CanonicalActionSubject {
  readonly schemaVersion: 1;
  readonly action: {
    readonly runId: string;
    readonly actionId: string;
    readonly actionName: string;
  };
  readonly adapter: CanonicalAdapterRegistrationIdentity;
  readonly executor: CanonicalExecutorRegistrationIdentity;
  readonly workspace: CanonicalWorkspaceIdentity;
  readonly identity: CanonicalActorIdentity;
  readonly environment: CanonicalEnvironmentIdentity;
  readonly operation: CanonicalActionOperation;
  readonly effectSet: ActionEffectSet;
  readonly requestedPermissions: CanonicalAdditionalPermissions | null;
  readonly preparedInvocationDigest: string;
  readonly targetAssertions: readonly TargetStateAssertion[];
}

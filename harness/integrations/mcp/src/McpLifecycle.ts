
import type { McpDiscoverySnapshot } from "./McpProtocol.js";
import type {
  McpProtocolRevision,
  McpTransportBindingIdentity,
} from "./McpRegistration.js";

export interface McpActivationRef {
  readonly serverId: string;
  readonly registrationFingerprint: string;
  readonly transportBindingFingerprint: string;
  readonly activationGeneration: number;
}

export interface McpActivationLookup {
  readonly serverId: string;
  readonly registrationFingerprint: string;
  readonly activationGeneration: number;
}

export interface McpActivationSnapshot extends McpActivationRef {
  readonly schemaVersion: 1;
  readonly activationId: string;
  readonly displayName: string;
  readonly authorityBindingId: string;
  readonly protocolRevision: McpProtocolRevision;
  readonly clientProfileId: string;
  readonly clientProfileFingerprint: string;
  readonly transport: McpTransportBindingIdentity;
  readonly transportConnectionId: string;
  readonly discovery: McpDiscoverySnapshot;
  readonly activatedAt: string;
}

export type McpLifecycleFailureCode =
  | "mcp_registration_stale"
  | "mcp_lifecycle_state_invalid"
  | "mcp_transport_connect_failed"
  | "mcp_transport_connect_timeout"
  | "mcp_transport_identity_mismatch"
  | "mcp_transport_closed"
  | "mcp_transport_failed"
  | "mcp_transport_shutdown_failed"
  | "mcp_transport_shutdown_timeout"
  | "mcp_discovery_failed"
  | "mcp_discovery_timeout"
  | "mcp_activation_cancelled"
  | "mcp_activation_stale"
  | "mcp_protocol_response_invalid"
  | "mcp_discovery_rejected"
  | "mcp_protocol_version_unsupported"
  | "mcp_required_capability_missing";

export interface McpLifecycleFailure {
  readonly code: McpLifecycleFailureCode;
  readonly message: string;
  readonly attemptId: string | null;
  readonly occurredAt: string;
}

interface McpLifecycleStateBase {
  readonly serverId: string;
  readonly registrationFingerprint: string;
  readonly status:
    | "registered"
    | "discovering"
    | "active"
    | "failed"
    | "stopping"
    | "stopped";
  readonly changedAt: string;
}

export interface McpRegisteredState extends McpLifecycleStateBase {
  readonly status: "registered";
}

export interface McpDiscoveringState extends McpLifecycleStateBase {
  readonly status: "discovering";
  readonly attemptId: string;
  readonly startedAt: string;
}

export interface McpActiveState extends McpLifecycleStateBase {
  readonly status: "active";
  readonly activation: McpActivationSnapshot;
}

export interface McpFailedState extends McpLifecycleStateBase {
  readonly status: "failed";
  readonly failure: McpLifecycleFailure;
}

export interface McpStoppingState extends McpLifecycleStateBase {
  readonly status: "stopping";
  readonly reason: "deactivated";
}

export interface McpStoppedState extends McpLifecycleStateBase {
  readonly status: "stopped";
  readonly reason: "deactivated";
}

export type McpLifecycleState =
  | McpRegisteredState
  | McpDiscoveringState
  | McpActiveState
  | McpFailedState
  | McpStoppingState
  | McpStoppedState;

export interface McpActivationResolver {
  resolveActivation(input: McpActivationLookup): McpActivationSnapshot | null;
}

export class McpActivationError extends Error {
  constructor(
    readonly code: McpLifecycleFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "McpActivationError";
  }
}

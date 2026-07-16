import type {
  ActionAdapterImplementation,
  ActionExecutor,
  ActionRegistrationSnapshot,
  CanonicalRemoteServerIdentity,
  SerializableValue,
} from "@agent-anything/agent-core/action-execution";
import type { Metadata } from "@agent-anything/shared";
import type {
  ToolAnnotations,
  ToolCatalogSnapshot,
  ToolJsonObject,
  ToolResult,
} from "@agent-anything/tools";

export interface TrustedRemoteActionRegistration {
  readonly actionName: string;
  readonly server: CanonicalRemoteServerIdentity;
  readonly serverDisplayName: string;
  readonly toolName: string;
  readonly toolDisplayName: string;
  readonly description?: string;
  readonly inputSchema: ToolJsonObject;
  readonly annotations?: ToolAnnotations;
  readonly supportsSessionAuthority: boolean;
  readonly timeoutMs: number | null;
}

export interface RemoteActionRegistrationResolver {
  resolve(
    serverId: string,
    toolName: string,
  ): Promise<TrustedRemoteActionRegistration | null>;
}

export interface RemoteActionInvokeInput {
  readonly actionId: string;
  readonly actionName: string;
  readonly serverId: string;
  readonly toolName: string;
  readonly input: SerializableValue;
  readonly timeoutMs: number | null;
}

export interface RemoteActionInvokePort {
  invoke(input: RemoteActionInvokeInput): Promise<ToolResult>;
}

export interface CreateRemoteActionCapabilityInput {
  readonly registration: TrustedRemoteActionRegistration;
  readonly registrationResolver?: RemoteActionRegistrationResolver;
  readonly invokePort: RemoteActionInvokePort;
  readonly now?: () => string;
}

export interface RemoteActionCapability {
  readonly catalog: ToolCatalogSnapshot;
  readonly registrations: ActionRegistrationSnapshot;
  readonly adapters: readonly ActionAdapterImplementation[];
  readonly executors: readonly ActionExecutor[];
}

export interface PreparedRemoteActionInvocationPayload {
  readonly actionName: string;
  readonly serverId: string;
  readonly registrationFingerprint: string;
  readonly transport: CanonicalRemoteServerIdentity["transport"];
  readonly endpoint: CanonicalRemoteServerIdentity["endpoint"];
  readonly toolName: string;
  readonly input: SerializableValue;
  readonly timeoutMs: number | null;
}

export interface RemoteActionResultMetadata extends Metadata {
  readonly remoteServerId: string;
  readonly remoteToolName: string;
}

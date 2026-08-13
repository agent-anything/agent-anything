import type {
  CanonicalRemoteServerIdentity,
  SerializableValue,
} from "@agent-anything/canonical-action/subject";
import type {
  ActionAdapterImplementation,
} from "@agent-anything/action-execution/registration";
import type { ActionRegistrationSnapshot } from "@agent-anything/canonical-action/registration";
import type {
  ActionExecutor,
} from "@agent-anything/action-execution/execution";

import type {
  ToolAnnotations,
  ToolJsonObject,
} from "@agent-anything/tools/catalog";
import type { ToolSchemaIdentity, ToolSourceRef } from "@agent-anything/tools/identity";
import type { ToolRegistrationSnapshot } from "@agent-anything/tools/registration";
import type { ToolResult } from "@agent-anything/tools/result";

export interface TrustedRemoteActionRegistration {
  readonly localToolName: string;
  readonly actionName: string;
  readonly source: ToolSourceRef & {
    readonly kind: "mcp" | "plugin" | "remote";
  };
  readonly sourceDisplayName: string;
  readonly server: CanonicalRemoteServerIdentity;
  readonly serverDisplayName: string;
  readonly toolName: string;
  readonly toolDisplayName: string;
  readonly description?: string;
  readonly inputSchema: ToolJsonObject;
  readonly schema: ToolSchemaIdentity;
  readonly annotations?: ToolAnnotations;
  readonly registrationVersion: string;
  readonly supportsSessionAuthority: boolean;
  readonly timeoutMs: number | null;
}

export interface RemoteActionRegistrationResolver {
  resolve(
    source: TrustedRemoteActionRegistration["source"],
    serverId: string,
    toolName: string,
  ): Promise<TrustedRemoteActionRegistration | null>;
}

export interface RemoteActionInvokeInput {
  readonly actionId: string;
  readonly actionName: string;
  readonly source: TrustedRemoteActionRegistration["source"];
  readonly serverId: string;
  readonly toolName: string;
  readonly input: SerializableValue;
  readonly timeoutMs: number | null;
  readonly signal: AbortSignal;
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
  readonly toolRegistrations: ToolRegistrationSnapshot;
  readonly actionRegistrations: ActionRegistrationSnapshot;
  readonly adapters: readonly ActionAdapterImplementation[];
  readonly executors: readonly ActionExecutor[];
}

export interface PreparedRemoteActionInvocationPayload {
  readonly actionName: string;
  readonly source: TrustedRemoteActionRegistration["source"];
  readonly serverId: string;
  readonly registrationFingerprint: string;
  readonly transport: CanonicalRemoteServerIdentity["transport"];
  readonly endpoint: CanonicalRemoteServerIdentity["endpoint"];
  readonly toolName: string;
  readonly input: SerializableValue;
  readonly timeoutMs: number | null;
}

export interface RemoteActionResultMetadata extends Readonly<Record<string, unknown>> {
  readonly remoteSourceKind: TrustedRemoteActionRegistration["source"]["kind"];
  readonly remoteSourceId: string;
  readonly remoteSourceCapabilityId: string;
  readonly remoteServerId: string;
  readonly remoteToolName: string;
}

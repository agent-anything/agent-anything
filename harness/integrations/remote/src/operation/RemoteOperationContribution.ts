import type { ActionAdapterImplementation } from "@agent-anything/action-execution/registration";
import type { ActionExecutor } from "@agent-anything/action-execution/execution";
import type { ActionRegistrationSnapshot } from "@agent-anything/canonical-action/registration";
import type {
  CanonicalRemoteServerIdentity,
  CanonicalRemoteSourceRef,
  SerializableValue,
} from "@agent-anything/canonical-action/subject";
import type { OperationBindingResolverRegistration } from "@agent-anything/operation-catalog/binding";
import type { RegisteredOperation } from "@agent-anything/operation-catalog/catalog";
import type { OperationRequestOrigin } from "@agent-anything/operation-catalog/catalog";
import type {
  OperationBindingRevisionRef,
  OperationRevisionRef,
} from "@agent-anything/operation-catalog/identity";
import type {
  ToolAnnotations,
  ToolJsonObject,
} from "@agent-anything/tools/catalog";
import type {
  ToolRevisionRef,
  ToolSchemaRevisionRefs,
} from "@agent-anything/tools/identity";
import type { ToolRegistrationInput } from "@agent-anything/tools/registration";
import type { RemoteOperationTransportPort } from "../transport/index.js";

export interface TrustedRemoteOperationRegistration {
  readonly operation: OperationRevisionRef;
  readonly binding: OperationBindingRevisionRef;
  readonly bindingKind: "direct" | "hosted";
  readonly hostedEndpointRef: string | null;
  readonly semanticOwner: string;
  readonly allowedRequestOrigins: readonly OperationRequestOrigin[];
  readonly source: CanonicalRemoteSourceRef;
  readonly sourceDisplayName: string;
  readonly server: CanonicalRemoteServerIdentity;
  readonly serverDisplayName: string;
  readonly remoteOperationName: string;
  readonly remoteOperationDisplayName: string;
  readonly localTool: {
    readonly ref: ToolRevisionRef;
    readonly name: string;
    readonly description?: string;
    readonly inputSchema: ToolJsonObject;
    readonly outputSchema?: ToolJsonObject;
    readonly schemaRevisions: ToolSchemaRevisionRefs;
    readonly annotations?: ToolAnnotations;
    readonly allowedOrigins: readonly ("model" | "workflow")[];
  } | null;
  readonly registrationRevision: string;
  readonly admittedAt: string;
  readonly supportsSessionAuthority: boolean;
  readonly timeoutMs: number | null;
}

export interface RemoteOperationRegistrationResolver {
  resolve(
    source: CanonicalRemoteSourceRef,
    serverId: string,
    remoteOperationName: string,
  ): Promise<TrustedRemoteOperationRegistration | null>;
}

export interface CreateRemoteOperationContributionInput<TOutput = unknown> {
  readonly registration: TrustedRemoteOperationRegistration;
  readonly registrationResolver?: RemoteOperationRegistrationResolver;
  readonly transport: RemoteOperationTransportPort<TOutput>;
  readonly now?: () => string;
}

export interface RemoteOperationContribution {
  readonly operations: readonly RegisteredOperation[];
  readonly bindings: readonly OperationBindingResolverRegistration[];
  readonly tools: readonly ToolRegistrationInput[];
  readonly actionRegistrations: ActionRegistrationSnapshot;
  readonly adapters: readonly ActionAdapterImplementation[];
  readonly executors: readonly ActionExecutor[];
}

export interface PreparedRemoteOperationInvocationPayload {
  readonly operationInvocationId: string;
  readonly source: CanonicalRemoteSourceRef;
  readonly server: CanonicalRemoteServerIdentity;
  readonly remoteOperationName: string;
  readonly input: SerializableValue;
  readonly timeoutMs: number | null;
}

export interface RemotePhysicalResult<TOutput = unknown> {
  readonly output: TOutput;
  readonly semanticError: {
    readonly code: string;
    readonly message: string;
    readonly metadata: Readonly<Record<string, unknown>>;
  } | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly startedAt: string;
  readonly finishedAt: string;
}

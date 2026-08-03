import type { ISODateTimeString } from "@agent-anything/foundation";
import type {
  ToolAnnotations,
  ToolJsonObject,
  ToolSchemaIdentity,
} from "@agent-anything/tools";
import type { McpToolHeaderBinding } from "./McpHeaders.js";
import type {
  McpJsonObject,
  McpJsonValue,
} from "./McpJson.js";
import type { McpActivationSnapshot } from "./McpLifecycle.js";
import type { McpCacheScope } from "./McpProtocol.js";

export type McpPrimitiveKind =
  | "tool"
  | "resource"
  | "resource-template"
  | "prompt";

export interface McpPrimitiveCache {
  readonly ttlMs: number;
  readonly scope: McpCacheScope;
  readonly receivedAt: ISODateTimeString;
  readonly expiresAt: ISODateTimeString;
}

export interface McpIcon {
  readonly src: string;
  readonly mimeType?: string;
  readonly sizes?: readonly string[];
  readonly theme?: "light" | "dark";
}

export interface McpResourceAnnotations {
  readonly audience?: readonly ("user" | "assistant")[];
  readonly priority?: number;
  readonly lastModified?: ISODateTimeString;
}

export interface McpToolDescriptor {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly icons: readonly McpIcon[];
  readonly inputSchema: ToolJsonObject;
  readonly outputSchema?: ToolJsonObject;
  readonly schema: ToolSchemaIdentity;
  readonly inputSchemaFingerprint: string;
  readonly outputSchemaFingerprint: string | null;
  readonly annotations: ToolAnnotations;
  readonly headerBindings: readonly McpToolHeaderBinding[];
  readonly sourceMetadata: McpJsonObject;
  readonly descriptorFingerprint: string;
}

export interface McpResourceDescriptor {
  readonly uri: string;
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly size?: number;
  readonly icons: readonly McpIcon[];
  readonly annotations: McpResourceAnnotations;
  readonly sourceMetadata: McpJsonObject;
  readonly descriptorFingerprint: string;
}

export interface McpResourceTemplateDescriptor {
  readonly uriTemplate: string;
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly icons: readonly McpIcon[];
  readonly annotations: McpResourceAnnotations;
  readonly sourceMetadata: McpJsonObject;
  readonly descriptorFingerprint: string;
}

export interface McpPromptArgumentDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly required: boolean;
}

export interface McpPromptDescriptor {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly arguments: readonly McpPromptArgumentDescriptor[];
  readonly icons: readonly McpIcon[];
  readonly sourceMetadata: McpJsonObject;
  readonly descriptorFingerprint: string;
}

export interface McpPrimitiveInventory<T> {
  readonly advertised: boolean;
  readonly snapshotId: string;
  readonly items: readonly T[];
  readonly cache: McpPrimitiveCache | null;
}

export interface McpPrimitiveDiagnostic {
  readonly primitive: McpPrimitiveKind;
  readonly itemIdentity: string | null;
  readonly code: string;
  readonly message: string;
}

export interface McpSourceLookup {
  readonly serverId: string;
  readonly registrationFingerprint: string;
  readonly sourceEpoch: number;
}

export interface McpSourceSnapshot extends McpSourceLookup {
  readonly schemaVersion: 1;
  readonly sourceSnapshotId: string;
  readonly authorityBindingId: string;
  readonly protocolRevision: "2026-07-28";
  readonly transportActivation: McpActivationSnapshot;
  readonly tools: McpPrimitiveInventory<McpToolDescriptor>;
  readonly resources: McpPrimitiveInventory<McpResourceDescriptor>;
  readonly resourceTemplates:
    McpPrimitiveInventory<McpResourceTemplateDescriptor>;
  readonly prompts: McpPrimitiveInventory<McpPromptDescriptor>;
  readonly diagnostics: readonly McpPrimitiveDiagnostic[];
  readonly publishedAt: ISODateTimeString;
}

export interface McpSourceResolver {
  resolveSource(input: McpSourceLookup): McpSourceSnapshot | null;
}

export interface RefreshMcpSourceInput {
  readonly serverId: string;
  readonly registrationFingerprint: string;
  readonly signal?: AbortSignal;
}

export interface McpTextResourceContent {
  readonly kind: "text";
  readonly uri: string;
  readonly mimeType: string | null;
  readonly text: string;
  readonly annotations: McpResourceAnnotations;
}

export interface McpBlobResourceContent {
  readonly kind: "blob";
  readonly uri: string;
  readonly mimeType: string | null;
  readonly base64Data: string;
  readonly annotations: McpResourceAnnotations;
}

export type McpResourceContent =
  | McpTextResourceContent
  | McpBlobResourceContent;

export interface McpResourceReadInput {
  readonly source: McpSourceLookup;
  readonly uri: string;
  readonly signal?: AbortSignal;
}

export interface McpResourceReadResult {
  readonly source: McpSourceLookup;
  readonly uri: string;
  readonly contents: readonly McpResourceContent[];
  readonly cache: McpPrimitiveCache;
  readonly resultFingerprint: string;
}

export interface McpResourcePort {
  read(input: McpResourceReadInput): Promise<McpResourceReadResult>;
}

export interface McpPromptMessage {
  readonly role: "user" | "assistant";
  readonly content: McpJsonObject;
}

export interface McpPromptGetInput {
  readonly source: McpSourceLookup;
  readonly name: string;
  readonly arguments?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export interface McpPromptGetResult {
  readonly source: McpSourceLookup;
  readonly name: string;
  readonly description: string | null;
  readonly messages: readonly McpPromptMessage[];
  readonly resultFingerprint: string;
}

export interface McpPromptPort {
  get(input: McpPromptGetInput): Promise<McpPromptGetResult>;
}

export interface McpToolCallOutput {
  readonly structuredContent?: McpJsonValue;
  readonly content: readonly McpJsonObject[];
}

export interface McpSubscriptionFilter {
  readonly toolsListChanged?: true;
  readonly promptsListChanged?: true;
  readonly resourcesListChanged?: true;
  readonly resourceSubscriptions?: readonly string[];
}

export type McpSubscriptionEvent =
  | { readonly kind: "tools-list-changed" }
  | { readonly kind: "prompts-list-changed" }
  | { readonly kind: "resources-list-changed" }
  | { readonly kind: "resource-updated"; readonly uri: string };

export interface McpSubscriptionAcknowledgement {
  readonly subscriptionId: string;
  readonly accepted: McpSubscriptionFilter;
}

export interface McpSubscriptionHandle {
  readonly subscriptionId: string;
  readonly source: McpSourceLookup;
  readonly acknowledged: Promise<McpSubscriptionAcknowledgement>;
  readonly completed: Promise<void>;
  cancel(): void;
}

export interface StartMcpSubscriptionInput {
  readonly source: McpSourceLookup;
  readonly filter: McpSubscriptionFilter;
  readonly signal?: AbortSignal;
}

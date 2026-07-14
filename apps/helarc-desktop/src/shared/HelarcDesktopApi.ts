import type {
  HelarcRunSnapshot,
  HelarcSessionHistoryRunRecord,
} from "@agent-anything/helarc";

export interface HelarcWorkspaceSnapshot {
  id: string;
  name: string;
  path: string;
}

export type HelarcWorkspaceTrustState = "trusted";

export interface HelarcWorkspaceProfileSnapshot {
  id: string;
  displayName: string;
  path: string;
  lastOpenedAt: string;
  trustState: HelarcWorkspaceTrustState;
}

export interface HelarcAcceptedTaskSnapshot {
  id: string;
  prompt: string;
}

export type HelarcTaskTemplateCategory =
  | "inspect"
  | "edit"
  | "test"
  | "refactor";

export interface HelarcTaskTemplateSnapshot {
  id: string;
  title: string;
  description: string;
  promptText: string;
  category: HelarcTaskTemplateCategory;
  defaultConstraints: string[];
}

export interface HelarcMainError {
  code: string;
  message: string;
}

export type HelarcProviderCredentialStatus =
  | "present"
  | "empty_allowed"
  | "missing";

export type HelarcProviderKind =
  | "openai-compatible"
  | "ollama";

export interface HelarcProviderProfileSnapshot {
  id: string;
  providerKind: HelarcProviderKind;
  displayName: string;
  endpointLabel: string;
  baseUrl: string;
  baseUrlOrigin: string;
  model: string;
  timeoutMs: number;
  credentialStatus: HelarcProviderCredentialStatus;
  isActive: boolean;
}

export type HelarcProviderSnapshot =
  | {
      configured: true;
      activeProfile: HelarcProviderProfileSnapshot;
      profiles: HelarcProviderProfileSnapshot[];
      error: null;
    }
  | {
      configured: false;
      activeProfile: null;
      profiles: HelarcProviderProfileSnapshot[];
      error: HelarcMainError;
    };

export type HelarcMainSnapshotStatus =
  | "idle"
  | "workspace_selected"
  | "running"
  | "cancelling"
  | "waiting_for_permission"
  | "waiting_for_patch_review"
  | "applying_patch"
  | "completed"
  | "rejected"
  | "failed"
  | "blocked"
  | "cancelled";

export interface HelarcPermissionPromptSnapshot {
  requestId: string;
  taskId: string;
  toolName: string;
  reason: string;
  command: string | null;
  args: string[];
  cwd: string | null;
  rootName: string | null;
}

export type HelarcConversationMessageRole =
  | "user"
  | "assistant"
  | "system"
  | "tool"
  | "product-event";

export interface HelarcConversationMessageSnapshot {
  id: string;
  role: HelarcConversationMessageRole;
  content: string;
  createdAt: string;
  relatedRunIds: string[];
  relatedArtifactIds: string[];
}

export type HelarcArtifactSnapshotKind =
  | "final-output"
  | "patch-proposal"
  | "applied-patch"
  | "trace-projection"
  | "tool-output-summary"
  | "error-report";

export interface HelarcArtifactSnapshot {
  id: string;
  kind: HelarcArtifactSnapshotKind;
  title: string;
  summary: string | null;
  createdAt: string;
  runId: string | null;
}

export interface HelarcActiveThreadSnapshot {
  id: string;
  title: string;
  status: "open" | "closed" | "archived";
  workspace: HelarcWorkspaceSnapshot;
  activeConversationId: string;
  messages: HelarcConversationMessageSnapshot[];
  artifacts: HelarcArtifactSnapshot[];
}

export type HelarcThreadRunStatus =
  | "starting"
  | "running"
  | "waiting_for_permission"
  | "cancelling"
  | "completed"
  | "failed"
  | "denied"
  | "cancelled";

export interface HelarcThreadLatestRunSnapshot {
  runId: string;
  status: HelarcThreadRunStatus;
  startedAt: string;
  completedAt: string | null;
}

export interface HelarcThreadSummarySnapshot {
  id: string;
  title: string;
  status: "open" | "closed" | "archived";
  workspace: HelarcWorkspaceSnapshot;
  createdAt: string;
  updatedAt: string;
  latestRun: HelarcThreadLatestRunSnapshot | null;
}

export interface HelarcPatchReviewViewModel {
  patchId: string;
  rootName: string;
  workspaceId: string;
  path: string;
  operation: "create" | "update" | "delete";
  summary: string;
  rationale: string;
  originalContent: string | null;
  proposedContent: string | null;
  originalContentBytes: number | null;
  proposedContentBytes: number | null;
  decisionState: "pending";
}

export interface HelarcActivityItem {
  id: string;
  sequence: number;
  timestamp: string;
  kind: string;
  title: string;
  detail: string | null;
  metadata: Record<string, unknown>;
}

export interface HelarcSessionOutput {
  taskId: string;
  workspaceId: string | null;
  agentSummary: string | null;
  runtimeStatus: string;
  patchStatus: "proposed" | "applied" | "rejected" | "failed" | null;
  appliedPath: string | null;
  safeErrors: Array<{ code: string; message: string }>;
}

export interface HelarcSessionHistoryWorkspaceRef {
  profileId: string | null;
  displayName: string;
  path: string;
}

export interface HelarcSessionHistoryProviderRef {
  profileId: string | null;
  displayName: string;
  endpointLabel: string;
  model: string;
}

export interface HelarcSessionHistoryPatchSummary {
  patchId: string | null;
  operation: "create" | "update" | "delete" | null;
  path: string | null;
  summary: string | null;
  decision: "accepted" | "rejected" | "not_required" | "unknown";
  reason: string | null;
  status: "proposed" | "applied" | "rejected" | "failed" | null;
}

export interface HelarcSessionHistoryRecord {
  id: string;
  taskId: string;
  taskText: string;
  workspace: HelarcSessionHistoryWorkspaceRef;
  provider: HelarcSessionHistoryProviderRef;
  startedAt: string;
  endedAt: string;
  status: "completed" | "rejected" | "failed" | "blocked" | "cancelled";
  activity: HelarcActivityItem[];
  output: HelarcSessionOutput;
  patch: HelarcSessionHistoryPatchSummary;
  run: HelarcSessionHistoryRunRecord;
}

export interface HelarcMainSnapshot {
  status: HelarcMainSnapshotStatus;
  workspace: HelarcWorkspaceSnapshot | null;
  workspaceProfiles: HelarcWorkspaceProfileSnapshot[];
  sessionHistory: HelarcSessionHistoryRecord[];
  taskTemplates: HelarcTaskTemplateSnapshot[];
  provider: HelarcProviderSnapshot;
  acceptedTask: HelarcAcceptedTaskSnapshot | null;
  pendingPermission: HelarcPermissionPromptSnapshot | null;
  pendingPatchReview: HelarcPatchReviewViewModel | null;
  activeThread: HelarcActiveThreadSnapshot | null;
  threadSummaries: HelarcThreadSummarySnapshot[];
  activity: HelarcActivityItem[];
  activeRun: HelarcRunSnapshot;
  output: HelarcSessionOutput | null;
  error: HelarcMainError | null;
}

export interface HelarcStartSessionInput {
  taskText: string;
}

export type HelarcStartSessionResult =
  | { ok: true; taskId: string; snapshot: HelarcMainSnapshot }
  | { ok: false; error: HelarcMainError; snapshot: HelarcMainSnapshot };

export interface HelarcResolvePermissionInput {
  requestId: string;
  decision: "granted" | "denied";
}

export type HelarcResolvePermissionResult =
  | { ok: true; snapshot: HelarcMainSnapshot }
  | { ok: false; error: HelarcMainError; snapshot: HelarcMainSnapshot };

export type HelarcCancelSessionResult =
  | { ok: true; snapshot: HelarcMainSnapshot }
  | { ok: false; error: HelarcMainError; snapshot: HelarcMainSnapshot };

export interface HelarcResolvePatchReviewInput {
  patchId: string;
  decision: "accepted" | "rejected";
  reason?: string;
}

export type HelarcResolvePatchReviewResult =
  | { ok: true; snapshot: HelarcMainSnapshot }
  | { ok: false; error: HelarcMainError; snapshot: HelarcMainSnapshot };

export interface HelarcSelectWorkspaceProfileInput {
  profileId: string;
}

export interface HelarcSaveProviderConfigInput {
  providerKind: HelarcProviderKind;
  displayName: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  apiKeyUpdate: "keep" | "set" | "clear";
  apiKey: string;
}

export interface HelarcDesktopApi {
  readonly bridgeVersion: 1;
  readonly productId: "helarc";
  chooseWorkspace(): Promise<HelarcMainSnapshot>;
  getSnapshot(): Promise<HelarcMainSnapshot>;
  saveProviderConfig(input: HelarcSaveProviderConfigInput): Promise<HelarcMainSnapshot>;
  selectWorkspaceProfile(input: HelarcSelectWorkspaceProfileInput): Promise<HelarcMainSnapshot>;
  startSession(input: HelarcStartSessionInput): Promise<HelarcStartSessionResult>;
  cancelSession(): Promise<HelarcCancelSessionResult>;
  resolvePermission(input: HelarcResolvePermissionInput): Promise<HelarcResolvePermissionResult>;
  resolvePatchReview(input: HelarcResolvePatchReviewInput): Promise<HelarcResolvePatchReviewResult>;
  subscribeSnapshot(listener: (snapshot: HelarcMainSnapshot) => void): () => void;
}

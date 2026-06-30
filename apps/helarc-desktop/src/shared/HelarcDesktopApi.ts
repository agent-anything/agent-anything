export interface HelarcWorkspaceSnapshot {
  id: string;
  name: string;
  path: string;
}

export interface HelarcAcceptedTaskSnapshot {
  id: string;
  prompt: string;
}

export interface HelarcMainError {
  code: string;
  message: string;
}

export type HelarcProviderCredentialStatus =
  | "present"
  | "empty_allowed"
  | "missing";

export interface HelarcProviderProfileSnapshot {
  id: string;
  displayName: string;
  endpointLabel: string;
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

export interface HelarcMainSnapshot {
  status: HelarcMainSnapshotStatus;
  workspace: HelarcWorkspaceSnapshot | null;
  provider: HelarcProviderSnapshot;
  acceptedTask: HelarcAcceptedTaskSnapshot | null;
  pendingPermission: HelarcPermissionPromptSnapshot | null;
  pendingPatchReview: HelarcPatchReviewViewModel | null;
  activity: HelarcActivityItem[];
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

export interface HelarcResolvePatchReviewInput {
  patchId: string;
  decision: "accepted" | "rejected";
  reason?: string;
}

export type HelarcResolvePatchReviewResult =
  | { ok: true; snapshot: HelarcMainSnapshot }
  | { ok: false; error: HelarcMainError; snapshot: HelarcMainSnapshot };

export interface HelarcDesktopApi {
  readonly bridgeVersion: 1;
  readonly productId: "helarc";
  chooseWorkspace(): Promise<HelarcMainSnapshot>;
  getSnapshot(): Promise<HelarcMainSnapshot>;
  startSession(input: HelarcStartSessionInput): Promise<HelarcStartSessionResult>;
  resolvePermission(input: HelarcResolvePermissionInput): Promise<HelarcResolvePermissionResult>;
  resolvePatchReview(input: HelarcResolvePatchReviewInput): Promise<HelarcResolvePatchReviewResult>;
  subscribeSnapshot(listener: (snapshot: HelarcMainSnapshot) => void): () => void;
}

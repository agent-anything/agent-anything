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

export type HelarcProviderSnapshot =
  | { configured: true; error: null }
  | { configured: false; error: HelarcMainError };

export type HelarcMainSnapshotStatus =
  | "idle"
  | "workspace_selected"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled";

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
  patchStatus: null;
  appliedPath: null;
  safeErrors: Array<{ code: string; message: string }>;
}

export interface HelarcMainSnapshot {
  status: HelarcMainSnapshotStatus;
  workspace: HelarcWorkspaceSnapshot | null;
  provider: HelarcProviderSnapshot;
  acceptedTask: HelarcAcceptedTaskSnapshot | null;
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

export interface HelarcDesktopApi {
  readonly bridgeVersion: 1;
  readonly productId: "helarc";
  chooseWorkspace(): Promise<HelarcMainSnapshot>;
  getSnapshot(): Promise<HelarcMainSnapshot>;
  startSession(input: HelarcStartSessionInput): Promise<HelarcStartSessionResult>;
}

export interface HelarcWorkspaceSnapshot {
  id: string;
  name: string;
  path: string;
}

export interface HelarcAcceptedTaskSnapshot {
  id: string;
  prompt: string;
}

export type HelarcMainSnapshotStatus = "idle" | "workspace_selected";

export interface HelarcMainError {
  code: string;
  message: string;
}

export interface HelarcMainSnapshot {
  status: HelarcMainSnapshotStatus;
  workspace: HelarcWorkspaceSnapshot | null;
  acceptedTask: HelarcAcceptedTaskSnapshot | null;
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

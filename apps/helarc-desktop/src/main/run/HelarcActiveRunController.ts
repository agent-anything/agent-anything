import type {
  HelarcRunEventViewModel,
  HelarcRunInput,
  HelarcRunPermissionPrompt,
  HelarcRunProviderRef,
  HelarcRunSnapshot,
  HelarcRunStatus,
  HelarcRunTerminalSummary,
  HelarcRunWorkspaceRef,
} from "@agent-anything/helarc";
import type { RunCancellationSummary } from "@agent-anything/agent-core";

type ISODateTimeString = string;
type Metadata = Record<string, unknown>;

export type HelarcActiveRunErrorCode =
  | "active_run_already_running"
  | "active_run_not_running"
  | "active_run_workspace_required"
  | "active_run_provider_required";

export interface HelarcActiveRunError {
  code: HelarcActiveRunErrorCode;
  message: string;
}

export interface StartHelarcActiveRunInput {
  run: HelarcRunInput;
  workspace: HelarcRunWorkspaceRef | null;
  provider: HelarcRunProviderRef | null;
  startedAt?: ISODateTimeString;
  metadata?: Metadata;
}

export type StartHelarcActiveRunResult =
  | { ok: true; snapshot: HelarcRunSnapshot }
  | { ok: false; error: HelarcActiveRunError; snapshot: HelarcRunSnapshot };

export type UpdateHelarcActiveRunResult =
  | { ok: true; snapshot: HelarcRunSnapshot }
  | { ok: false; error: HelarcActiveRunError; snapshot: HelarcRunSnapshot };

export class HelarcActiveRunController {
  private snapshot: HelarcRunSnapshot = createIdleSnapshot();
  private readonly subscribers = new Set<(snapshot: HelarcRunSnapshot) => void>();

  getSnapshot(): HelarcRunSnapshot {
    return this.snapshot;
  }

  subscribe(subscriber: (snapshot: HelarcRunSnapshot) => void): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  startRun(input: StartHelarcActiveRunInput): StartHelarcActiveRunResult {
    if (isActiveStatus(this.snapshot.status)) {
      return this.reject(
        "active_run_already_running",
        "A Helarc run is already active.",
      );
    }

    if (!input.workspace) {
      return this.reject(
        "active_run_workspace_required",
        "A Helarc run requires a trusted workspace reference.",
      );
    }

    if (!input.provider) {
      return this.reject(
        "active_run_provider_required",
        "A Helarc run requires a provider reference.",
      );
    }

    this.snapshot = {
      runId: input.run.runId,
      status: "starting",
      task: {
        text: input.run.taskText,
        templateId: input.run.taskTemplateId,
      },
      workspace: input.workspace,
      provider: input.provider,
      events: [],
      pendingPermission: null,
      cancellation: null,
      terminal: null,
      startedAt: input.startedAt ?? input.run.createdAt,
      metadata: {
        ...input.run.metadata,
        ...(input.metadata ?? {}),
      },
    };

    return { ok: true, snapshot: this.publishSnapshot() };
  }

  markRunning(): UpdateHelarcActiveRunResult {
    if (!isActiveStatus(this.snapshot.status)) {
      return this.reject(
        "active_run_not_running",
        "No Helarc run is active.",
      );
    }

    this.snapshot = {
      ...this.snapshot,
      status: "running",
    };
    return { ok: true, snapshot: this.publishSnapshot() };
  }

  appendEvent(event: HelarcRunEventViewModel): UpdateHelarcActiveRunResult {
    if (!isActiveStatus(this.snapshot.status)) {
      return this.reject(
        "active_run_not_running",
        "No Helarc run is active.",
      );
    }

    this.snapshot = {
      ...this.snapshot,
      events: [...this.snapshot.events, event],
    };
    return { ok: true, snapshot: this.publishSnapshot() };
  }

  requestPermission(prompt: HelarcRunPermissionPrompt): UpdateHelarcActiveRunResult {
    if (!isActiveStatus(this.snapshot.status)) {
      return this.reject(
        "active_run_not_running",
        "No Helarc run is active.",
      );
    }

    this.snapshot = {
      ...this.snapshot,
      status: "waiting_for_permission",
      pendingPermission: prompt,
    };
    return { ok: true, snapshot: this.publishSnapshot() };
  }

  resolvePermission(): UpdateHelarcActiveRunResult {
    if (!isActiveStatus(this.snapshot.status)) {
      return this.reject(
        "active_run_not_running",
        "No Helarc run is active.",
      );
    }

    this.snapshot = {
      ...this.snapshot,
      status: "running",
      pendingPermission: null,
    };
    return { ok: true, snapshot: this.publishSnapshot() };
  }

  requestCancel(cancellation: RunCancellationSummary): UpdateHelarcActiveRunResult {
    if (!isActiveStatus(this.snapshot.status)) {
      return this.reject(
        "active_run_not_running",
        "No Helarc run is active.",
      );
    }

    this.snapshot = {
      ...this.snapshot,
      status: "cancelling",
      pendingPermission: null,
      cancellation: Object.freeze({ ...cancellation }),
    };
    return { ok: true, snapshot: this.publishSnapshot() };
  }

  completeRun(terminal: HelarcRunTerminalSummary): UpdateHelarcActiveRunResult {
    if (!isActiveStatus(this.snapshot.status)) {
      return this.reject(
        "active_run_not_running",
        "No Helarc run is active.",
      );
    }

    this.snapshot = {
      ...this.snapshot,
      status: terminal.status,
      pendingPermission: null,
      cancellation: terminal.cancellation,
      terminal,
    };
    return { ok: true, snapshot: this.publishSnapshot() };
  }

  reset(): HelarcRunSnapshot {
    this.snapshot = createIdleSnapshot();
    return this.publishSnapshot();
  }

  private reject(
    code: HelarcActiveRunErrorCode,
    message: string,
  ): { ok: false; error: HelarcActiveRunError; snapshot: HelarcRunSnapshot } {
    return {
      ok: false,
      error: { code, message },
      snapshot: this.snapshot,
    };
  }

  private publishSnapshot(): HelarcRunSnapshot {
    for (const subscriber of this.subscribers) {
      subscriber(this.snapshot);
    }
    return this.snapshot;
  }
}

function createIdleSnapshot(): HelarcRunSnapshot {
  return {
    runId: "",
    status: "idle",
    task: {
      text: "",
      templateId: null,
    },
    workspace: null,
    provider: null,
    events: [],
    pendingPermission: null,
    cancellation: null,
    terminal: null,
    startedAt: null,
    metadata: {},
  };
}

function isActiveStatus(status: HelarcRunStatus): boolean {
  return status === "starting" ||
    status === "running" ||
    status === "waiting_for_permission" ||
    status === "cancelling";
}

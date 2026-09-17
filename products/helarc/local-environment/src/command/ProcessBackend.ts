export type ProcessStream = "stdout" | "stderr";

export interface ProcessBackendDescriptor {
  readonly kind: "windows_job" | "posix_process_group";
  readonly revision: string;
  readonly limitations: readonly string[];
}

export interface ProcessLaunchRequest {
  readonly executionId: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly startupTimeoutMs: number;
}

export type ProcessBackendEvent =
  | { readonly kind: "output"; readonly stream: ProcessStream; readonly bytes: Uint8Array }
  | { readonly kind: "root_exit"; readonly code: number | null; readonly signal: string | null }
  | { readonly kind: "scope_empty" }
  | { readonly kind: "output_closed"; readonly incomplete: boolean }
  | { readonly kind: "failure"; readonly code: string; readonly message: string };

export interface ProcessBackendHandle {
  readonly processId: number;
  readonly helperProcessId: number | null;
  readonly startIdentity: string;
  terminate(): Promise<"graceful" | "forced">;
  close(): Promise<void>;
}

export interface ProcessBackend {
  readonly descriptor: ProcessBackendDescriptor;
  launch(request: ProcessLaunchRequest, publish: (event: ProcessBackendEvent) => void): Promise<ProcessBackendHandle>;
}

export class ProcessLaunchFailure extends Error {
  constructor(readonly code: string, message: string, readonly effectState: "none" | "unknown") {
    super(message);
    this.name = "ProcessLaunchFailure";
  }
}

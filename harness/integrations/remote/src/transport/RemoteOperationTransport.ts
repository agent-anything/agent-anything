import type { SerializableValue } from "@agent-anything/canonical-action/subject";

export interface RemoteOperationTransportInput {
  readonly actionId: string;
  readonly operationInvocationId: string;
  readonly sourceKind: "mcp" | "plugin" | "remote";
  readonly sourceId: string;
  readonly serverId: string;
  readonly remoteOperationName: string;
  readonly input: SerializableValue;
  readonly timeoutMs: number | null;
  readonly signal: AbortSignal;
}

export interface RemoteOperationSemanticError {
  readonly code: string;
  readonly message: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface RemoteOperationTransportEvidence {
  readonly code: string;
  readonly message: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export type RemoteOperationTransportOutcome<TOutput = unknown> =
  | {
      readonly status: "completed";
      readonly output: TOutput;
      readonly semanticError: RemoteOperationSemanticError | null;
      readonly metadata: Readonly<Record<string, unknown>>;
    }
  | {
      readonly status: "failed";
      readonly effectState: "none" | "settled" | "unknown";
      readonly failure: RemoteOperationTransportEvidence & {
        readonly retryable: boolean;
      };
    }
  | {
      readonly status: "interrupted";
      readonly effectState: "none" | "settled" | "unknown";
      readonly evidence: RemoteOperationTransportEvidence;
    }
  | {
      readonly status: "timed_out";
      readonly effectState: "none" | "settled" | "unknown";
      readonly evidence: RemoteOperationTransportEvidence;
    };

/** Performs only the attributed remote protocol exchange. */
export interface RemoteOperationTransportPort<TOutput = unknown> {
  invoke(
    input: RemoteOperationTransportInput,
  ): Promise<RemoteOperationTransportOutcome<TOutput>>;
}

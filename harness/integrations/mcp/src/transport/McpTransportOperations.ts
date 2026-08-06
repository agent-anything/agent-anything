import { validateMcpToken } from "../protocol/McpJson.js";
import type { McpServerRegistration } from "../registration/McpRegistration.js";
import type {
  McpTransportCloseRequest,
  McpTransportConnection,
  McpTransportConnector,
  McpTransportOperationControl,
  McpTransportRequest,
  McpTransportResponseStream,
} from "./McpTransport.js";

interface McpTransportOperationScope {
  readonly control: McpTransportOperationControl;
  clearTimeout(): void;
  dispose(): void;
}

interface McpTransportSettlementInput {
  readonly registration: McpServerRegistration;
  readonly operationId: string;
  readonly timeoutMs: number;
  readonly parentSignal?: AbortSignal;
  readonly sourceEpoch: number | null;
  readonly timeoutError: Error;
  readonly cancellationError: Error;
}

export interface McpTransportOperationsDependencies {
  readonly connector: McpTransportConnector;
  readonly now: () => Date;
}

export class McpTransportOperations {
  private readonly connectionClosures =
    new WeakMap<McpTransportConnection, Promise<void>>();

  constructor(private readonly dependencies: McpTransportOperationsDependencies) {}

  async connect(input: McpTransportSettlementInput): Promise<McpTransportConnection> {
    const scope = this.createScope(input);
    const operation = Promise.resolve(
      this.dependencies.connector.connect(
        Object.freeze({
          registrationFingerprint:
            input.registration.registrationFingerprint,
          binding: input.registration.transport,
          credentialRef: input.registration.credentialRef,
        }),
        scope.control,
      ),
    );
    void operation.then(
      (lateConnection) => {
        if (!scope.control.signal.aborted) return;
        void this.close({
          registration: input.registration,
          connection: lateConnection,
          operationId: `${input.operationId}:late-close`,
          reason: "stale_connection",
          sourceEpoch: null,
          timeoutError: new Error("MCP stale transport shutdown timed out."),
          cancellationError:
            new Error("MCP stale transport shutdown was cancelled."),
        }).catch(() => undefined);
      },
      () => undefined,
    );
    try {
      return await raceWithSignal(operation, scope.control.signal);
    } finally {
      scope.dispose();
    }
  }

  async request(input: McpTransportSettlementInput & {
    readonly connection: McpTransportConnection;
    readonly request: McpTransportRequest;
  }): Promise<unknown> {
    const scope = this.createScope(input);
    try {
      return await raceWithSignal(
        Promise.resolve(input.connection.request(input.request, scope.control)),
        scope.control.signal,
      );
    } finally {
      scope.dispose();
    }
  }

  async openStream(input: McpTransportSettlementInput & {
    readonly connection: McpTransportConnection;
    readonly request: McpTransportRequest;
  }): Promise<McpTransportResponseStream> {
    const scope = this.createScope(input);
    try {
      const stream = await raceWithSignal(
        Promise.resolve(input.connection.openStream(input.request, scope.control)),
        scope.control.signal,
      );
      scope.clearTimeout();
      if (!isTransportResponseStream(stream)) {
        throw new TypeError("MCP transport returned an invalid response stream.");
      }
      return Object.freeze({
        messages: finalizeResponseStream(stream.messages, () => scope.dispose()),
      });
    } catch (error) {
      scope.dispose();
      throw error;
    }
  }

  close(input: {
    readonly registration: McpServerRegistration;
    readonly connection: McpTransportConnection;
    readonly operationId: string;
    readonly reason: McpTransportCloseRequest["reason"];
    readonly sourceEpoch: number | null;
    readonly timeoutError: Error;
    readonly cancellationError: Error;
  }): Promise<void> {
    const existing = this.connectionClosures.get(input.connection);
    if (existing !== undefined) return existing;
    const closure = this.performClose(input);
    this.connectionClosures.set(input.connection, closure);
    return closure;
  }

  private async performClose(input: {
    readonly registration: McpServerRegistration;
    readonly connection: McpTransportConnection;
    readonly operationId: string;
    readonly reason: McpTransportCloseRequest["reason"];
    readonly sourceEpoch: number | null;
    readonly timeoutError: Error;
    readonly cancellationError: Error;
  }): Promise<void> {
    const scope = this.createScope({
      registration: input.registration,
      operationId: input.operationId,
      timeoutMs: input.registration.limits.shutdownTimeoutMs,
      sourceEpoch: input.sourceEpoch,
      timeoutError: input.timeoutError,
      cancellationError: input.cancellationError,
    });
    try {
      await raceWithSignal(
        Promise.resolve(
          input.connection.close(
            Object.freeze({ reason: input.reason }),
            scope.control,
          ),
        ),
        scope.control.signal,
      );
    } finally {
      scope.dispose();
    }
  }

  private createScope(
    input: McpTransportSettlementInput,
  ): McpTransportOperationScope {
    const controller = new AbortController();
    const removeParentAbort = linkAbortSignal(
      input.parentSignal,
      controller,
      input.cancellationError,
    );
    const startedAt = this.dependencies.now();
    if (
      !(startedAt instanceof Date) ||
      !Number.isFinite(startedAt.getTime())
    ) {
      removeParentAbort();
      throw new TypeError("MCP transport clock returned an invalid Date.");
    }
    const deadlineMs = startedAt.getTime() + input.timeoutMs;
    if (!Number.isSafeInteger(deadlineMs)) {
      removeParentAbort();
      throw input.timeoutError;
    }
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      controller.abort(input.timeoutError);
    }, input.timeoutMs);
    const clearOperationTimeout = () => {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
    };
    return {
      control: Object.freeze({
        operationId: validateMcpToken(
          input.operationId,
          "transport.operationId",
          1_024,
        ),
        registrationFingerprint:
          input.registration.registrationFingerprint,
        sourceEpoch: input.sourceEpoch,
        deadlineAt: new Date(deadlineMs).toISOString(),
        signal: controller.signal,
      }),
      clearTimeout: clearOperationTimeout,
      dispose() {
        clearOperationTimeout();
        removeParentAbort();
      },
    };
  }
}

function linkAbortSignal(
  source: AbortSignal | undefined,
  target: AbortController,
  error: Error,
): () => void {
  if (source === undefined) return () => undefined;
  const abort = () => target.abort(error);
  if (source.aborted) {
    abort();
    return () => undefined;
  }
  source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

async function raceWithSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw interruptionError(signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => settle(() => reject(interruptionError(signal)));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error)),
    );
  });
}

function interruptionError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("MCP transport operation was cancelled.");
}

function isTransportResponseStream(
  input: unknown,
): input is McpTransportResponseStream {
  if (input === null || typeof input !== "object") return false;
  const messages = (input as { readonly messages?: unknown }).messages;
  return messages !== null &&
    typeof messages === "object" &&
    typeof (messages as AsyncIterable<unknown>)[Symbol.asyncIterator] ===
      "function";
}

async function* finalizeResponseStream(
  messages: AsyncIterable<unknown>,
  dispose: () => void,
): AsyncIterable<unknown> {
  try {
    yield* messages;
  } finally {
    dispose();
  }
}

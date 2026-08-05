import { randomUUID } from "node:crypto";

import {
  McpActivationError,
  type McpActivationLookup,
  type McpActivationResolver,
  type McpActivationSnapshot,
  type McpLifecycleFailure,
  type McpLifecycleState,
} from "./McpLifecycle.js";
import {
  createMcpContractFingerprint,
  type McpJsonObject,
  validateMcpToken,
} from "./McpJson.js";
import {
  createMcpOperationRequest,
  createMcpDiscoverRequest,
  McpOperationError,
  McpProtocolError,
  parseMcpDiscoverResponse,
} from "./McpProtocol.js";
import {
  McpPrimitiveCoordinator,
  McpPrimitiveError,
  type McpPrimitiveTransportLease,
} from "./McpPrimitiveCoordinator.js";
import type {
  McpPromptGetInput,
  McpPromptGetResult,
  McpResourceReadInput,
  McpResourceReadResult,
  McpSourceLookup,
  McpSourceResolver,
  McpSourceSnapshot,
  McpSubscriptionHandle,
  RefreshMcpSourceInput,
  StartMcpSubscriptionInput,
} from "./McpPrimitives.js";
import {
  createMcpServerRegistration,
  type McpServerRegistration,
  type McpServerRegistrationInput,
  type McpTransportBindingIdentity,
} from "./McpRegistration.js";
import type {
  McpToolCallInput,
  McpToolCallResult,
  McpToolOperationPort,
} from "./McpToolOperationPort.js";
import type {
  McpTransportCloseRequest,
  McpTransportConnection,
  McpTransportConnectionIdentity,
  McpTransportConnector,
  McpTransportOperationControl,
  McpTransportResponseStream,
} from "./McpTransport.js";

export interface McpRegistryDependencies {
  readonly connector: McpTransportConnector;
  readonly now?: () => Date;
  readonly createId?: () => string;
}

export interface ActivateMcpServerInput {
  readonly serverId: string;
  readonly registrationFingerprint: string;
  readonly signal?: AbortSignal;
}

export interface DeactivateMcpServerInput {
  readonly serverId: string;
  readonly registrationFingerprint: string;
}

export interface ReplaceMcpServerRegistrationInput {
  readonly expectedRegistrationFingerprint: string;
  readonly registration: McpServerRegistrationInput;
}

interface ActivationAttempt {
  readonly generation: number;
  readonly attemptId: string;
  readonly controller: AbortController;
  connection: McpTransportConnection | null;
}

interface ActiveTransport {
  readonly generation: number;
  readonly connection: McpTransportConnection;
  readonly snapshot: McpActivationSnapshot;
}

interface ServerRecord {
  registration: McpServerRegistration;
  state: McpLifecycleState;
  generation: number;
  nextActivationGeneration: number;
  attempt: ActivationAttempt | null;
  active: ActiveTransport | null;
}

interface OperationScope {
  readonly control: McpTransportOperationControl;
  dispose(): void;
}

export class McpRegistry implements
  McpActivationResolver,
  McpSourceResolver,
  McpToolOperationPort {
  private readonly records = new Map<string, ServerRecord>();
  private readonly connectionClosures =
    new WeakMap<McpTransportConnection, Promise<void>>();
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly primitives: McpPrimitiveCoordinator;

  constructor(private readonly dependencies: McpRegistryDependencies) {
    if (
      dependencies === null ||
      typeof dependencies !== "object" ||
      typeof dependencies.connector?.connect !== "function"
    ) {
      throw new TypeError("MCP Registry requires a transport connector.");
    }
    this.now = dependencies.now ?? (() => new Date());
    this.createId = dependencies.createId ?? randomUUID;
    this.primitives = new McpPrimitiveCoordinator({
      getActiveLease: (serverId, registrationFingerprint) =>
        this.getActiveLease(serverId, registrationFingerprint),
      isLeaseCurrent: (lease) => this.isLeaseCurrent(lease),
      request: (input) => this.performPrimitiveRequest(input),
      openStream: (input) => this.openPrimitiveStream(input),
      invalidateLease: (lease, error) =>
        this.invalidatePrimitiveLease(lease, error),
      now: () => this.nowDate(),
      createId: () => this.createId(),
    });
  }

  register(input: McpServerRegistrationInput): McpServerRegistration {
    const registration = createMcpServerRegistration(input);
    if (this.records.has(registration.serverId)) {
      throw new McpActivationError(
        "mcp_lifecycle_state_invalid",
        `MCP server '${registration.serverId}' is already registered.`,
      );
    }
    const changedAt = this.nowIso();
    this.records.set(registration.serverId, {
      registration,
      state: Object.freeze({
        serverId: registration.serverId,
        registrationFingerprint: registration.registrationFingerprint,
        status: "registered",
        changedAt,
      }),
      generation: 0,
      nextActivationGeneration: 1,
      attempt: null,
      active: null,
    });
    return registration;
  }

  replaceRegistration(
    input: ReplaceMcpServerRegistrationInput,
  ): McpServerRegistration {
    const registration = createMcpServerRegistration(input.registration);
    const record = this.requireRecord(registration.serverId);
    this.assertCurrentRegistration(
      record,
      input.expectedRegistrationFingerprint,
    );
    if (record.state.status !== "registered" && record.state.status !== "stopped") {
      throw new McpActivationError(
        "mcp_lifecycle_state_invalid",
        "MCP registration replacement requires a registered or stopped server.",
      );
    }
    record.generation += 1;
    this.primitives.invalidate(registration.serverId);
    record.registration = registration;
    record.state = Object.freeze({
      serverId: registration.serverId,
      registrationFingerprint: registration.registrationFingerprint,
      status: "registered",
      changedAt: this.nowIso(),
    });
    return registration;
  }

  async activate(
    input: ActivateMcpServerInput,
  ): Promise<McpActivationSnapshot> {
    const record = this.requireRecord(input.serverId);
    this.assertCurrentRegistration(record, input.registrationFingerprint);
    if (
      record.state.status !== "registered" &&
      record.state.status !== "failed" &&
      record.state.status !== "stopped"
    ) {
      throw new McpActivationError(
        "mcp_lifecycle_state_invalid",
        `MCP server '${input.serverId}' cannot activate from '${record.state.status}'.`,
      );
    }

    const registration = record.registration;
    const generation = record.generation + 1;
    record.generation = generation;
    this.primitives.invalidate(registration.serverId);
    const attemptId = this.nextId("activation attempt");
    const controller = new AbortController();
    const removeExternalAbort = linkAbortSignal(
      input.signal,
      controller,
      new McpActivationError(
        "mcp_activation_cancelled",
        "MCP activation was cancelled.",
      ),
    );
    const attempt: ActivationAttempt = {
      generation,
      attemptId,
      controller,
      connection: null,
    };
    record.attempt = attempt;
    record.active = null;
    const startedAt = this.nowIso();
    record.state = Object.freeze({
      serverId: registration.serverId,
      registrationFingerprint: registration.registrationFingerprint,
      status: "discovering",
      attemptId,
      startedAt,
      changedAt: startedAt,
    });

    let stage: "connecting" | "discovering" = "connecting";
    let connection: McpTransportConnection | null = null;
    try {
      const connectScope = this.createOperationScope({
        registration,
        operationId: `${attemptId}:connect`,
        timeoutMs: registration.limits.connectTimeoutMs,
        timeoutCode: "mcp_transport_connect_timeout",
        timeoutMessage: "MCP transport connection timed out.",
        parentSignal: controller.signal,
        sourceEpoch: null,
      });
      try {
        const connectPromise = Promise.resolve(
          this.dependencies.connector.connect(
            Object.freeze({
              registrationFingerprint: registration.registrationFingerprint,
              binding: registration.transport,
              credentialRef: registration.credentialRef,
            }),
            connectScope.control,
          ),
        );
        void connectPromise.then(
          (lateConnection) => {
            if (!this.isCurrentAttempt(record, attempt)) {
              void this.closeConnection(
                registration,
                lateConnection,
                "stale_connection",
                null,
              ).catch(() => undefined);
            }
          },
          () => undefined,
        );
        connection = await raceWithSignal(
          connectPromise,
          connectScope.control.signal,
        );
      } finally {
        connectScope.dispose();
      }

      if (!this.isCurrentAttempt(record, attempt)) {
        throw staleActivation();
      }
      validateConnectionIdentity(connection, registration);
      attempt.connection = connection;
      stage = "discovering";

      const requestId = this.nextId("protocol request");
      const request = createMcpDiscoverRequest({
        requestId,
        transportKind: registration.transport.kind,
        client: registration.client,
      });
      const requestScope = this.createOperationScope({
        registration,
        operationId: `${attemptId}:discover`,
        timeoutMs: registration.limits.requestTimeoutMs,
        timeoutCode: "mcp_discovery_timeout",
        timeoutMessage: "MCP server discovery timed out.",
        parentSignal: controller.signal,
        sourceEpoch: null,
      });
      let rawResponse: unknown;
      try {
        rawResponse = await raceWithSignal(
          Promise.resolve(connection.request(request, requestScope.control)),
          requestScope.control.signal,
        );
      } finally {
        requestScope.dispose();
      }
      if (!this.isCurrentAttempt(record, attempt)) {
        throw staleActivation();
      }

      const activatedAt = this.nowIso();
      const discovery = parseMcpDiscoverResponse({
        response: rawResponse,
        requestId,
        requiredCapabilities: registration.requiredCapabilities,
        maxTtlMs: registration.limits.maxDiscoveryTtlMs,
        receivedAt: activatedAt,
      });
      if (!this.isCurrentAttempt(record, attempt)) {
        throw staleActivation();
      }

      const activationGeneration = record.nextActivationGeneration;
      const activationFields = Object.freeze({
        schemaVersion: 1 as const,
        serverId: registration.serverId,
        registrationFingerprint: registration.registrationFingerprint,
        transportBindingFingerprint:
          registration.transport.bindingFingerprint,
        activationGeneration,
        displayName: registration.displayName,
        authorityBindingId: registration.authorityBindingId,
        protocolRevision: registration.protocolRevision,
        clientProfileId: registration.client.profileId,
        clientProfileFingerprint: registration.client.profileFingerprint,
        transport: registration.transport,
        transportConnectionId: connection.identity.connectionId,
        discovery,
        activatedAt,
      });
      const snapshot = Object.freeze({
        ...activationFields,
        activationId: createMcpContractFingerprint(
          "agent-anything.mcp-activation.v1",
          activationFields,
        ),
      });

      record.nextActivationGeneration += 1;
      record.attempt = null;
      record.active = {
        generation,
        connection,
        snapshot,
      };
      record.state = Object.freeze({
        serverId: registration.serverId,
        registrationFingerprint: registration.registrationFingerprint,
        status: "active",
        activation: snapshot,
        changedAt: activatedAt,
      });
      this.observeConnectionClosure(record, record.active);
      return snapshot;
    } catch (error) {
      const current = this.isCurrentAttempt(record, attempt);
      if (current) {
        controller.abort(error);
        record.attempt = null;
        record.active = null;
        let normalized = normalizeActivationError(error, stage);
        if (connection !== null) {
          try {
            await this.closeConnection(
              registration,
              connection,
              "activation_failed",
              null,
            );
          } catch (closeError) {
            normalized = normalizeShutdownError(closeError);
          }
        }
        record.state = Object.freeze({
          serverId: registration.serverId,
          registrationFingerprint: registration.registrationFingerprint,
          status: "failed",
          failure: this.failure(normalized, attemptId),
          changedAt: this.nowIso(),
        });
        throw normalized;
      }
      if (connection !== null) {
        void this.closeConnection(
          registration,
          connection,
          "activation_failed",
          null,
        ).catch(() => undefined);
      }
      throw staleActivation();
    } finally {
      removeExternalAbort();
    }
  }

  async deactivate(input: DeactivateMcpServerInput): Promise<void> {
    const record = this.requireRecord(input.serverId);
    this.assertCurrentRegistration(record, input.registrationFingerprint);
    if (record.state.status === "stopped") return;
    if (record.state.status === "stopping") {
      throw new McpActivationError(
        "mcp_lifecycle_state_invalid",
        `MCP server '${input.serverId}' is already stopping.`,
      );
    }

    const registration = record.registration;
    const attempt = record.attempt;
    const active = record.active;
    record.generation += 1;
    record.attempt = null;
    record.active = null;
    this.primitives.invalidate(registration.serverId);
    attempt?.controller.abort(new McpActivationError(
      "mcp_activation_cancelled",
      "MCP activation was stopped.",
    ));
    record.state = Object.freeze({
      serverId: registration.serverId,
      registrationFingerprint: registration.registrationFingerprint,
      status: "stopping",
      reason: "deactivated",
      changedAt: this.nowIso(),
    });

    const connection = active?.connection ?? attempt?.connection ?? null;
    if (connection !== null) {
      try {
        await this.closeConnection(
          registration,
          connection,
          "deactivated",
          null,
        );
      } catch (error) {
        const normalized = normalizeShutdownError(error);
        record.state = Object.freeze({
          serverId: registration.serverId,
          registrationFingerprint: registration.registrationFingerprint,
          status: "failed",
          failure: this.failure(normalized, attempt?.attemptId ?? null),
          changedAt: this.nowIso(),
        });
        throw normalized;
      }
    }
    record.state = Object.freeze({
      serverId: registration.serverId,
      registrationFingerprint: registration.registrationFingerprint,
      status: "stopped",
      reason: "deactivated",
      changedAt: this.nowIso(),
    });
  }

  getRegistration(serverId: string): McpServerRegistration | null {
    return this.records.get(serverId)?.registration ?? null;
  }

  listRegistrations(): readonly McpServerRegistration[] {
    return Object.freeze([...this.records.values()]
      .map((record) => record.registration)
      .sort((left, right) => compareStrings(left.serverId, right.serverId)));
  }

  getState(serverId: string): McpLifecycleState | null {
    return this.records.get(serverId)?.state ?? null;
  }

  listStates(): readonly McpLifecycleState[] {
    return Object.freeze([...this.records.values()]
      .map((record) => record.state)
      .sort((left, right) => compareStrings(left.serverId, right.serverId)));
  }

  getActiveSnapshot(serverId: string): McpActivationSnapshot | null {
    return this.records.get(serverId)?.active?.snapshot ?? null;
  }

  listActiveSnapshots(): readonly McpActivationSnapshot[] {
    return Object.freeze([...this.records.values()]
      .flatMap((record) => record.active === null ? [] : [record.active.snapshot])
      .sort((left, right) => compareStrings(left.serverId, right.serverId)));
  }

  resolveActivation(input: McpActivationLookup): McpActivationSnapshot | null {
    const snapshot = this.getActiveSnapshot(input.serverId);
    return snapshot !== null &&
        snapshot.registrationFingerprint === input.registrationFingerprint &&
        snapshot.activationGeneration === input.activationGeneration
      ? snapshot
      : null;
  }

  refreshSource(input: RefreshMcpSourceInput): Promise<McpSourceSnapshot> {
    return this.primitives.refresh(input);
  }

  getSourceSnapshot(serverId: string): McpSourceSnapshot | null {
    return this.primitives.getSnapshot(serverId);
  }

  resolveSource(input: McpSourceLookup): McpSourceSnapshot | null {
    return this.primitives.resolveSource(input);
  }

  callTool<TInput = unknown>(
    input: McpToolCallInput<TInput>,
  ): Promise<McpToolCallResult> {
    return this.primitives.callTool(input);
  }

  readResource(input: McpResourceReadInput): Promise<McpResourceReadResult> {
    return this.primitives.readResource(input);
  }

  getPrompt(input: McpPromptGetInput): Promise<McpPromptGetResult> {
    return this.primitives.getPrompt(input);
  }

  startSubscription(
    input: StartMcpSubscriptionInput,
  ): Promise<McpSubscriptionHandle> {
    return this.primitives.startSubscription(input);
  }

  private getActiveLease(
    serverId: string,
    registrationFingerprint: string,
  ): McpPrimitiveTransportLease | null {
    const record = this.records.get(serverId);
    if (
      record === undefined ||
      record.registration.registrationFingerprint !== registrationFingerprint ||
      record.active === null ||
      record.state.status !== "active"
    ) {
      return null;
    }
    return Object.freeze({
      registration: record.registration,
      activation: record.active.snapshot,
    });
  }

  private isLeaseCurrent(lease: McpPrimitiveTransportLease): boolean {
    const active = this.records.get(lease.registration.serverId)?.active;
    return active !== null &&
      active !== undefined &&
      active.snapshot.activationId === lease.activation.activationId &&
      active.snapshot.registrationFingerprint ===
        lease.registration.registrationFingerprint;
  }

  private async performPrimitiveRequest(input: {
    readonly lease: McpPrimitiveTransportLease;
    readonly requestId: string;
    readonly method: string;
    readonly params: McpJsonObject;
    readonly name?: string;
    readonly parameterHeaders?: Readonly<Record<string, string>>;
    readonly sourceEpoch: number | null;
    readonly signal?: AbortSignal;
  }): Promise<unknown> {
    const active = this.requireActiveTransport(input.lease);
    const request = createMcpOperationRequest({
      requestId: input.requestId,
      transportKind: input.lease.registration.transport.kind,
      client: input.lease.registration.client,
      method: input.method,
      params: input.params,
      name: input.name,
      parameterHeaders: input.parameterHeaders,
    });
    const scope = this.createPrimitiveOperationScope({
      registration: input.lease.registration,
      operationId: input.requestId,
      timeoutMs: input.lease.registration.limits.requestTimeoutMs,
      parentSignal: input.signal,
      sourceEpoch: input.sourceEpoch,
    });
    try {
      const response = await raceWithSignal(
        Promise.resolve(active.connection.request(request, scope.control)),
        scope.control.signal,
      );
      if (!this.isLeaseCurrent(input.lease)) {
        throw new McpPrimitiveError(
          "mcp_source_stale",
          "MCP operation completed for a stale transport activation.",
        );
      }
      return response;
    } catch (error) {
      if (
        error instanceof McpPrimitiveError ||
        error instanceof McpOperationError
      ) {
        throw error;
      }
      throw new McpPrimitiveError(
        "mcp_operation_failed",
        "MCP transport request failed.",
      );
    } finally {
      scope.dispose();
    }
  }

  private async openPrimitiveStream(input: {
    readonly lease: McpPrimitiveTransportLease;
    readonly requestId: string;
    readonly method: "subscriptions/listen";
    readonly params: McpJsonObject;
    readonly sourceEpoch: number;
    readonly signal: AbortSignal;
  }): Promise<McpTransportResponseStream> {
    const active = this.requireActiveTransport(input.lease);
    const request = createMcpOperationRequest({
      requestId: input.requestId,
      transportKind: input.lease.registration.transport.kind,
      client: input.lease.registration.client,
      method: input.method,
      params: input.params,
    });
    const controller = new AbortController();
    const removeParentAbort = linkAbortSignal(
      input.signal,
      controller,
      new McpPrimitiveError(
        "mcp_operation_cancelled",
        "MCP subscription was cancelled.",
      ),
    );
    const timer = setTimeout(() => {
      controller.abort(new McpPrimitiveError(
        "mcp_operation_timeout",
        "MCP subscription opening timed out.",
      ));
    }, input.lease.registration.limits.requestTimeoutMs);
    const control = Object.freeze({
      operationId: validateMcpToken(
        input.requestId,
        "transport.operationId",
        1_024,
      ),
      registrationFingerprint:
        input.lease.registration.registrationFingerprint,
      sourceEpoch: input.sourceEpoch,
      deadlineAt: null,
      signal: controller.signal,
    });
    try {
      const stream = await raceWithSignal(
        Promise.resolve(active.connection.openStream(request, control)),
        control.signal,
      );
      clearTimeout(timer);
      if (
        !this.isLeaseCurrent(input.lease) ||
        !isTransportResponseStream(stream)
      ) {
        controller.abort();
        throw new McpPrimitiveError(
          "mcp_source_stale",
          "MCP subscription opened for an invalid or stale transport.",
        );
      }
      return Object.freeze({
        messages: finalizeResponseStream(
          stream.messages,
          removeParentAbort,
        ),
      });
    } catch (error) {
      clearTimeout(timer);
      removeParentAbort();
      if (
        error instanceof McpPrimitiveError ||
        error instanceof McpOperationError
      ) {
        throw error;
      }
      throw new McpPrimitiveError(
        "mcp_operation_failed",
        "MCP subscription transport failed to open.",
      );
    }
  }

  private requireActiveTransport(
    lease: McpPrimitiveTransportLease,
  ): ActiveTransport {
    const active = this.records.get(lease.registration.serverId)?.active;
    if (
      active === null ||
      active === undefined ||
      active.snapshot.activationId !== lease.activation.activationId ||
      active.snapshot.registrationFingerprint !==
        lease.registration.registrationFingerprint
    ) {
      throw new McpPrimitiveError(
        "mcp_source_stale",
        "MCP transport lease is unavailable or stale.",
      );
    }
    return active;
  }

  private invalidatePrimitiveLease(
    lease: McpPrimitiveTransportLease,
    error: McpOperationError,
  ): void {
    const record = this.records.get(lease.registration.serverId);
    const active = record?.active;
    if (
      record === undefined ||
      active === null ||
      active === undefined ||
      active.snapshot.activationId !== lease.activation.activationId
    ) {
      return;
    }
    const sourceEpoch =
      this.primitives.getSnapshot(lease.registration.serverId)?.sourceEpoch ??
        null;
    record.generation += 1;
    record.active = null;
    this.primitives.invalidate(lease.registration.serverId);
    const normalized = new McpActivationError(
      "mcp_protocol_version_unsupported",
      error.message,
    );
    record.state = Object.freeze({
      serverId: record.registration.serverId,
      registrationFingerprint: record.registration.registrationFingerprint,
      status: "failed",
      failure: this.failure(normalized, null),
      changedAt: this.nowIso(),
    });
    void this.closeConnection(
      record.registration,
      active.connection,
      "activation_failed",
      sourceEpoch,
    ).catch(() => undefined);
  }

  private createPrimitiveOperationScope(input: {
    readonly registration: McpServerRegistration;
    readonly operationId: string;
    readonly timeoutMs: number;
    readonly parentSignal?: AbortSignal;
    readonly sourceEpoch: number | null;
  }): OperationScope {
    const controller = new AbortController();
    const removeParentAbort = linkAbortSignal(
      input.parentSignal,
      controller,
      new McpPrimitiveError(
        "mcp_operation_cancelled",
        "MCP operation was cancelled.",
      ),
    );
    const startedAt = this.nowDate();
    const deadlineMs = startedAt.getTime() + input.timeoutMs;
    if (!Number.isSafeInteger(deadlineMs)) {
      removeParentAbort();
      throw new McpPrimitiveError(
        "mcp_operation_timeout",
        "MCP operation deadline is invalid.",
      );
    }
    const timer = setTimeout(() => {
      controller.abort(new McpPrimitiveError(
        "mcp_operation_timeout",
        "MCP operation timed out.",
      ));
    }, input.timeoutMs);
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
      dispose() {
        clearTimeout(timer);
        removeParentAbort();
      },
    };
  }

  private observeConnectionClosure(
    record: ServerRecord,
    active: ActiveTransport,
  ): void {
    void Promise.resolve(active.connection.closed).then(
      (closure) => {
        if (
          record.active !== active ||
          record.generation !== active.generation ||
          record.state.status !== "active"
        ) {
          return;
        }
        record.generation += 1;
        record.active = null;
        this.primitives.invalidate(record.registration.serverId);
        const failed = closure?.kind === "failed";
        const error = new McpActivationError(
          failed ? "mcp_transport_failed" : "mcp_transport_closed",
          failed
            ? "MCP transport failed after activation."
            : "MCP transport closed after activation.",
        );
        record.state = Object.freeze({
          serverId: record.registration.serverId,
          registrationFingerprint:
            record.registration.registrationFingerprint,
          status: "failed",
          failure: this.failure(error, null),
          changedAt: this.nowIso(),
        });
      },
      () => {
        if (
          record.active !== active ||
          record.generation !== active.generation ||
          record.state.status !== "active"
        ) {
          return;
        }
        record.generation += 1;
        record.active = null;
        this.primitives.invalidate(record.registration.serverId);
        const error = new McpActivationError(
          "mcp_transport_failed",
          "MCP transport closure reporting failed.",
        );
        record.state = Object.freeze({
          serverId: record.registration.serverId,
          registrationFingerprint:
            record.registration.registrationFingerprint,
          status: "failed",
          failure: this.failure(error, null),
          changedAt: this.nowIso(),
        });
      },
    );
  }

  private async closeConnection(
    registration: McpServerRegistration,
    connection: McpTransportConnection,
    reason: McpTransportCloseRequest["reason"],
    sourceEpoch: number | null,
  ): Promise<void> {
    const existing = this.connectionClosures.get(connection);
    if (existing !== undefined) return existing;
    const closure = this.performConnectionClose(
      registration,
      connection,
      reason,
      sourceEpoch,
    );
    this.connectionClosures.set(connection, closure);
    return closure;
  }

  private async performConnectionClose(
    registration: McpServerRegistration,
    connection: McpTransportConnection,
    reason: McpTransportCloseRequest["reason"],
    sourceEpoch: number | null,
  ): Promise<void> {
    const scope = this.createOperationScope({
      registration,
      operationId: `${this.nextId("transport close")}:close`,
      timeoutMs: registration.limits.shutdownTimeoutMs,
      timeoutCode: "mcp_transport_shutdown_timeout",
      timeoutMessage: "MCP transport shutdown timed out.",
      sourceEpoch,
    });
    try {
      await raceWithSignal(
        Promise.resolve(connection.close(Object.freeze({ reason }), scope.control)),
        scope.control.signal,
      );
    } catch (error) {
      if (
        error instanceof McpActivationError &&
        error.code === "mcp_transport_shutdown_timeout"
      ) {
        throw error;
      }
      throw new McpActivationError(
        "mcp_transport_shutdown_failed",
        "MCP transport shutdown failed.",
      );
    } finally {
      scope.dispose();
    }
  }

  private createOperationScope(input: {
    readonly registration: McpServerRegistration;
    readonly operationId: string;
    readonly timeoutMs: number;
    readonly timeoutCode:
      | "mcp_transport_connect_timeout"
      | "mcp_discovery_timeout"
      | "mcp_transport_shutdown_timeout";
    readonly timeoutMessage: string;
    readonly parentSignal?: AbortSignal;
    readonly sourceEpoch: number | null;
  }): OperationScope {
    const controller = new AbortController();
    const removeParentAbort = linkAbortSignal(
      input.parentSignal,
      controller,
      new McpActivationError(
        "mcp_activation_cancelled",
        "MCP operation was cancelled.",
      ),
    );
    const startedAt = this.nowDate();
    const deadlineMs = startedAt.getTime() + input.timeoutMs;
    if (!Number.isSafeInteger(deadlineMs)) {
      removeParentAbort();
      throw new McpActivationError(
        input.timeoutCode,
        input.timeoutMessage,
      );
    }
    const deadlineAt = new Date(deadlineMs).toISOString();
    const timer = setTimeout(() => {
      controller.abort(new McpActivationError(
        input.timeoutCode,
        input.timeoutMessage,
      ));
    }, input.timeoutMs);
    const control = Object.freeze({
      operationId: validateMcpToken(
        input.operationId,
        "transport.operationId",
        1_024,
      ),
      registrationFingerprint:
        input.registration.registrationFingerprint,
      sourceEpoch: input.sourceEpoch,
      deadlineAt,
      signal: controller.signal,
    });
    return {
      control,
      dispose() {
        clearTimeout(timer);
        removeParentAbort();
      },
    };
  }

  private assertCurrentRegistration(
    record: ServerRecord,
    expectedFingerprint: string,
  ): void {
    if (record.registration.registrationFingerprint !== expectedFingerprint) {
      throw new McpActivationError(
        "mcp_registration_stale",
        `MCP registration for '${record.registration.serverId}' is stale.`,
      );
    }
  }

  private isCurrentAttempt(
    record: ServerRecord,
    attempt: ActivationAttempt,
  ): boolean {
    return record.attempt === attempt &&
      record.generation === attempt.generation;
  }

  private requireRecord(serverId: string): ServerRecord {
    const id = validateMcpToken(serverId, "serverId");
    const record = this.records.get(id);
    if (record === undefined) {
      throw new McpActivationError(
        "mcp_lifecycle_state_invalid",
        `MCP server '${id}' is not registered.`,
      );
    }
    return record;
  }

  private failure(
    error: McpActivationError,
    attemptId: string | null,
  ): McpLifecycleFailure {
    return Object.freeze({
      code: error.code,
      message: error.message,
      attemptId,
      occurredAt: this.nowIso(),
    });
  }

  private nextId(subject: string): string {
    return validateMcpToken(
      this.createId(),
      `MCP ${subject} id`,
      512,
    );
  }

  private nowDate(): Date {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new TypeError("MCP Registry clock returned an invalid Date.");
    }
    return value;
  }

  private nowIso(): string {
    return this.nowDate().toISOString();
  }
}

function validateConnectionIdentity(
  connection: McpTransportConnection,
  registration: McpServerRegistration,
): void {
  if (
    connection === null ||
    typeof connection !== "object" ||
    typeof connection.request !== "function" ||
    typeof connection.openStream !== "function" ||
    typeof connection.close !== "function" ||
    connection.closed === null ||
    typeof connection.closed !== "object" ||
    typeof connection.closed.then !== "function"
  ) {
    throw new McpActivationError(
      "mcp_transport_identity_mismatch",
      "MCP connector returned an invalid transport connection.",
    );
  }
  const identity = connection.identity;
  if (
    identity === null ||
    typeof identity !== "object" ||
    identity.registrationFingerprint !==
      registration.registrationFingerprint ||
    !sameBinding(identity.binding, registration.transport)
  ) {
    throw new McpActivationError(
      "mcp_transport_identity_mismatch",
      "MCP transport connection does not match the trusted registration.",
    );
  }
  try {
    validateMcpToken(identity.connectionId, "transport.connectionId", 512);
  } catch {
    throw new McpActivationError(
      "mcp_transport_identity_mismatch",
      "MCP transport connection identity is invalid.",
    );
  }
}

function sameBinding(
  actual: McpTransportConnectionIdentity["binding"],
  expected: McpTransportBindingIdentity,
): boolean {
  return actual.kind === expected.kind &&
    actual.bindingId === expected.bindingId &&
    actual.bindingRevision === expected.bindingRevision &&
    actual.configurationRef === expected.configurationRef &&
    actual.bindingFingerprint === expected.bindingFingerprint;
}

function normalizeActivationError(
  error: unknown,
  stage: "connecting" | "discovering",
): McpActivationError {
  if (error instanceof McpActivationError) return error;
  if (error instanceof McpProtocolError) {
    return new McpActivationError(error.code, error.message);
  }
  return new McpActivationError(
    stage === "connecting"
      ? "mcp_transport_connect_failed"
      : "mcp_discovery_failed",
    stage === "connecting"
      ? "MCP transport connection failed."
      : "MCP server discovery failed.",
  );
}

function normalizeShutdownError(error: unknown): McpActivationError {
  return error instanceof McpActivationError
    ? error
    : new McpActivationError(
      "mcp_transport_shutdown_failed",
      "MCP transport shutdown failed.",
    );
}

function staleActivation(): McpActivationError {
  return new McpActivationError(
    "mcp_activation_stale",
    "MCP activation result is stale.",
  );
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
    : new McpActivationError(
      "mcp_activation_cancelled",
      "MCP operation was cancelled.",
    );
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

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

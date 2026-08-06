
import {
  deriveMcpToolParameterHeaders,
} from "../protocol/McpHeaders.js";
import {
  createMcpContractFingerprint,
  snapshotMcpJsonObject,
  validateMcpToken,
} from "../protocol/McpJson.js";
import {
  parseMcpPromptGetResult,
  parseMcpPromptsListPage,
  parseMcpResourceReadResult,
  parseMcpResourcesListPage,
  parseMcpResourceTemplatesListPage,
  parseMcpToolCallResult,
  parseMcpToolsListPage,
  type McpParsedTool,
} from "../protocol/McpPrimitiveProtocol.js";
import type {
  McpPromptDescriptor,
  McpPromptGetInput,
  McpPromptGetResult,
  McpResourceDescriptor,
  McpResourceReadInput,
  McpResourceReadResult,
  McpResourceTemplateDescriptor,
  McpSourceLookup,
  McpSourceSnapshot,
  McpSubscriptionAcknowledgement,
  McpSubscriptionFilter,
  McpSubscriptionHandle,
  McpToolDescriptor,
  RefreshMcpSourceInput,
  StartMcpSubscriptionInput,
} from "./McpPrimitives.js";
import {
  McpOperationError,
} from "../protocol/McpProtocol.js";
import type {
  McpToolCallInput,
  McpToolCallResult,
} from "./McpToolOperationPort.js";
import type { McpTransportResponseStream } from "../transport/McpTransport.js";
import {
  McpPrimitiveInventoryLoader,
  replaceInventoryItems,
  requireFreshInventory,
  sourceSnapshotFresh,
  unsupportedInventory,
} from "./McpPrimitiveInventory.js";
import { McpPrimitiveError } from "./McpPrimitiveError.js";
import { validateMcpPromptArguments } from "./McpPromptArguments.js";
import {
  createMcpResourceCacheKey,
  getFreshMcpResourceCache,
  invalidateMcpResourceCache,
  validateMcpResourceUri,
} from "./McpResourceCache.js";
import {
  isMcpJsonRpcResponse,
  mcpSubscriptionFilterToJson,
  mcpSubscriptionInterruption,
  mcpSubscriptionInvalid,
  nextMcpSubscriptionMessage,
  parseMcpSubscriptionCompletion,
  parseMcpSubscriptionNotification,
  validateMcpAcknowledgedFilter,
  validateMcpSubscribedEvent,
  validateMcpSubscriptionFilter,
} from "./McpSubscriptionProtocol.js";
import type {
  McpPrimitiveCoordinatorDependencies,
  McpPrimitiveTransportLease,
} from "./McpPrimitiveTransport.js";

const SUBSCRIPTION_ACK_TIMEOUT_MS = 10_000;

interface PublishedRuntime {
  readonly snapshot: McpSourceSnapshot;
  readonly toolsByName: ReadonlyMap<string, McpParsedTool>;
}

interface SourceRecord {
  nextSourceEpoch: number;
  generation: number;
  published: PublishedRuntime | null;
  refresh:
    | {
        readonly generation: number;
        readonly activationId: string;
        readonly controller: AbortController;
        readonly promise: Promise<McpSourceSnapshot>;
      }
    | null;
  readonly resourceCache: Map<string, McpResourceReadResult>;
  readonly subscriptions: Set<AbortController>;
}

export class McpPrimitiveCoordinator {
  private readonly records = new Map<string, SourceRecord>();
  private readonly inventory: McpPrimitiveInventoryLoader;

  constructor(private readonly dependencies: McpPrimitiveCoordinatorDependencies) {
    this.inventory = new McpPrimitiveInventoryLoader({
      request: dependencies.request,
      nextId: (subject) => this.nextId(subject),
      nowIso: () => this.nowIso(),
    });
  }

  async refresh(input: RefreshMcpSourceInput): Promise<McpSourceSnapshot> {
    const lease = this.requireActiveLease(
      input.serverId,
      input.registrationFingerprint,
    );
    const record = this.record(input.serverId);
    if (
      record.refresh !== null &&
      record.refresh.activationId === lease.activation.activationId
    ) {
      return record.refresh.promise;
    }
    record.refresh?.controller.abort();

    const generation = record.generation;
    const controller = new AbortController();
    const removeExternalAbort = linkAbortSignal(input.signal, controller);
    const promise = this.performRefresh(record, lease, generation, controller)
      .finally(() => {
        removeExternalAbort();
        if (record.refresh?.promise === promise) record.refresh = null;
      });
    record.refresh = {
      generation,
      activationId: lease.activation.activationId,
      controller,
      promise,
    };
    return promise;
  }

  getSnapshot(serverId: string): McpSourceSnapshot | null {
    return this.records.get(serverId)?.published?.snapshot ?? null;
  }

  resolveSource(input: McpSourceLookup): McpSourceSnapshot | null {
    const published = this.records.get(input.serverId)?.published;
    const lease = this.dependencies.getActiveLease(
      input.serverId,
      input.registrationFingerprint,
    );
    if (
      published === null ||
      published === undefined ||
      lease === null ||
      published.snapshot.registrationFingerprint !==
        input.registrationFingerprint ||
      published.snapshot.sourceEpoch !== input.sourceEpoch ||
      lease.activation.activationId !==
        published.snapshot.transportActivation.activationId ||
      !this.dependencies.isLeaseCurrent(lease) ||
      !sourceSnapshotFresh(published.snapshot, this.nowMs())
    ) {
      return null;
    }
    return published.snapshot;
  }

  invalidate(serverId: string): void {
    const record = this.records.get(serverId);
    if (record === undefined) return;
    record.generation += 1;
    record.refresh?.controller.abort();
    record.refresh = null;
    record.published = null;
    record.resourceCache.clear();
    for (const controller of record.subscriptions) controller.abort();
    record.subscriptions.clear();
  }

  async callTool(
    input: McpToolCallInput,
  ): Promise<McpToolCallResult> {
    const { record, runtime, lease } = this.requireCurrentRuntime(input.source);
    requireFreshInventory(runtime.snapshot.tools, this.nowMs(), "Tool");
    const tool = runtime.toolsByName.get(input.toolName);
    if (tool === undefined) {
      throw new McpPrimitiveError(
        "mcp_primitive_not_found",
        `MCP Tool '${input.toolName}' is not in the current source snapshot.`,
      );
    }
    const argumentsValue = snapshotMcpJsonObject(
      input.input,
      "toolCall.input",
    );
    const validation = tool.inputValidator.validate(argumentsValue);
    if (!validation.valid) {
      throw new McpPrimitiveError(
        "mcp_tool_input_invalid",
        "MCP Tool input does not match the accepted input schema.",
      );
    }
    const parameterHeaders = deriveMcpToolParameterHeaders({
      bindings: tool.descriptor.headerBindings,
      argumentsValue,
    });
    const requestId = this.nextId("Tool request");
    const response = await this.dependencies.request({
      lease,
      requestId,
      method: "tools/call",
      params: Object.freeze({
        name: input.toolName,
        arguments: argumentsValue,
      }),
      name: input.toolName,
      parameterHeaders,
      sourceEpoch: input.source.sourceEpoch,
      signal: input.signal,
    });
    this.assertRuntimeCurrent(record, runtime, lease);
    let parsed: ReturnType<typeof parseMcpToolCallResult>;
    try {
      parsed = parseMcpToolCallResult({
        response,
        requestId,
        outputValidator: tool.outputValidator,
      });
    } catch (error) {
      this.invalidateForProtocolRevision(lease, error);
      throw error;
    }
    return Object.freeze({
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      isError: parsed.isError,
      output: parsed.output,
      metadata: Object.freeze({
        sourceSnapshotId: runtime.snapshot.sourceSnapshotId,
        sourceEpoch: runtime.snapshot.sourceEpoch,
        toolDescriptorFingerprint:
          tool.descriptor.descriptorFingerprint,
      } satisfies Readonly<Record<string, unknown>>),
    });
  }

  async readResource(
    input: McpResourceReadInput,
  ): Promise<McpResourceReadResult> {
    const { record, runtime, lease } = this.requireCurrentRuntime(input.source);
    requireFreshInventory(
      runtime.snapshot.resources,
      this.nowMs(),
      "Resource",
    );
    const uri = validateMcpResourceUri(input.uri);
    const cacheKey = createMcpResourceCacheKey(runtime.snapshot, uri);
    const cached = getFreshMcpResourceCache(
      record.resourceCache,
      cacheKey,
      this.nowMs(),
    );
    if (cached !== null) {
      return cached;
    }

    const requestId = this.nextId("Resource request");
    const response = await this.dependencies.request({
      lease,
      requestId,
      method: "resources/read",
      params: Object.freeze({ uri }),
      name: uri,
      sourceEpoch: input.source.sourceEpoch,
      signal: input.signal,
    });
    this.assertRuntimeCurrent(record, runtime, lease);
    let result: McpResourceReadResult;
    try {
      result = parseMcpResourceReadResult({
        response,
        requestId,
        source: input.source,
        requestedUri: uri,
        receivedAt: this.nowIso(),
        maxTtlMs: lease.registration.limits.maxDiscoveryTtlMs,
      });
    } catch (error) {
      this.invalidateForProtocolRevision(lease, error);
      throw error;
    }
    if (result.cache.ttlMs > 0) {
      record.resourceCache.set(
        `${cacheKey}\u0000${result.cache.scope}`,
        result,
      );
    }
    return result;
  }

  async getPrompt(input: McpPromptGetInput): Promise<McpPromptGetResult> {
    const { record, runtime, lease } = this.requireCurrentRuntime(input.source);
    requireFreshInventory(runtime.snapshot.prompts, this.nowMs(), "Prompt");
    const prompt = runtime.snapshot.prompts.items.find(
      (candidate) => candidate.name === input.name,
    );
    if (prompt === undefined) {
      throw new McpPrimitiveError(
        "mcp_primitive_not_found",
        `MCP Prompt '${input.name}' is not in the current source snapshot.`,
      );
    }
    const args = validateMcpPromptArguments(prompt, input.arguments ?? {});
    const requestId = this.nextId("Prompt request");
    const response = await this.dependencies.request({
      lease,
      requestId,
      method: "prompts/get",
      params: Object.freeze({
        name: prompt.name,
        ...(Object.keys(args).length === 0 ? {} : { arguments: args }),
      }),
      name: prompt.name,
      sourceEpoch: input.source.sourceEpoch,
      signal: input.signal,
    });
    this.assertRuntimeCurrent(record, runtime, lease);
    try {
      return parseMcpPromptGetResult({
        response,
        requestId,
        source: input.source,
        name: prompt.name,
      });
    } catch (error) {
      this.invalidateForProtocolRevision(lease, error);
      throw error;
    }
  }

  async startSubscription(
    input: StartMcpSubscriptionInput,
  ): Promise<McpSubscriptionHandle> {
    const { record, runtime, lease } = this.requireCurrentRuntime(input.source);
    const requested = validateMcpSubscriptionFilter(
      input.filter,
      runtime.snapshot,
    );
    const subscriptionId = this.nextId("subscription");
    const controller = new AbortController();
    const removeExternalAbort = linkAbortSignal(input.signal, controller);
    record.subscriptions.add(controller);
    let resolveAcknowledged!: (
      value: McpSubscriptionAcknowledgement,
    ) => void;
    let rejectAcknowledged!: (reason: unknown) => void;
    const acknowledged = new Promise<McpSubscriptionAcknowledgement>(
      (resolve, reject) => {
        resolveAcknowledged = resolve;
        rejectAcknowledged = reject;
      },
    );
    let acknowledgedSettled = false;
    let stream: McpTransportResponseStream;
    try {
      stream = await this.dependencies.openStream({
        lease,
        requestId: subscriptionId,
        method: "subscriptions/listen",
        params: Object.freeze({
          notifications: mcpSubscriptionFilterToJson(requested),
        }),
        sourceEpoch: input.source.sourceEpoch,
        signal: controller.signal,
      });
    } catch (error) {
      removeExternalAbort();
      record.subscriptions.delete(controller);
      this.invalidateForProtocolRevision(lease, error);
      throw error;
    }
    const completed = this.consumeSubscription({
      record,
      runtime,
      lease,
      source: input.source,
      subscriptionId,
      requested,
      stream,
      controller,
      resolveAcknowledged(value) {
        acknowledgedSettled = true;
        resolveAcknowledged(value);
      },
    }).catch((error) => {
      if (!acknowledgedSettled) rejectAcknowledged(error);
      throw error;
    }).finally(() => {
      removeExternalAbort();
      record.subscriptions.delete(controller);
    });

    return Object.freeze({
      subscriptionId,
      source: Object.freeze({ ...input.source }),
      acknowledged,
      completed,
      cancel() {
        controller.abort();
      },
    });
  }

  private async performRefresh(
    record: SourceRecord,
    lease: McpPrimitiveTransportLease,
    generation: number,
    controller: AbortController,
  ): Promise<McpSourceSnapshot> {
    try {
      const capabilities =
        lease.activation.discovery.serverCapabilities.capabilities;
      const refreshSourceEpoch =
        record.published?.snapshot.sourceEpoch ?? null;
      const toolsAdvertised = Object.hasOwn(capabilities, "tools");
      const resourcesAdvertised = Object.hasOwn(capabilities, "resources");
      const promptsAdvertised = Object.hasOwn(capabilities, "prompts");

      const tools = toolsAdvertised
        ? await this.inventory.load({
            lease,
            sourceEpoch: refreshSourceEpoch,
            method: "tools/list",
            signal: controller.signal,
            identity: (item: McpParsedTool) => item.descriptor.name,
            descriptor: (item: McpParsedTool) => item.descriptor,
            parser: (response, requestId, receivedAt) =>
              parseMcpToolsListPage({
                response,
                requestId,
                receivedAt,
                maxTtlMs: lease.registration.limits.maxDiscoveryTtlMs,
                transportKind: lease.registration.transport.kind,
              }),
          })
        : unsupportedInventory<McpParsedTool>("tools");
      const resources = resourcesAdvertised
        ? await this.inventory.load({
            lease,
            sourceEpoch: refreshSourceEpoch,
            method: "resources/list",
            signal: controller.signal,
            identity: (item: McpResourceDescriptor) => item.uri,
            descriptor: (item: McpResourceDescriptor) => item,
            parser: (response, requestId, receivedAt) =>
              parseMcpResourcesListPage({
                response,
                requestId,
                receivedAt,
                maxTtlMs: lease.registration.limits.maxDiscoveryTtlMs,
              }),
          })
        : unsupportedInventory<McpResourceDescriptor>("resources");
      const resourceTemplates = resourcesAdvertised
        ? await this.inventory.load({
            lease,
            sourceEpoch: refreshSourceEpoch,
            method: "resources/templates/list",
            signal: controller.signal,
            identity: (item: McpResourceTemplateDescriptor) =>
              item.uriTemplate,
            descriptor: (item: McpResourceTemplateDescriptor) => item,
            parser: (response, requestId, receivedAt) =>
              parseMcpResourceTemplatesListPage({
                response,
                requestId,
                receivedAt,
                maxTtlMs: lease.registration.limits.maxDiscoveryTtlMs,
              }),
          })
        : unsupportedInventory<McpResourceTemplateDescriptor>(
            "resourceTemplates",
          );
      const prompts = promptsAdvertised
        ? await this.inventory.load({
            lease,
            sourceEpoch: refreshSourceEpoch,
            method: "prompts/list",
            signal: controller.signal,
            identity: (item: McpPromptDescriptor) => item.name,
            descriptor: (item: McpPromptDescriptor) => item,
            parser: (response, requestId, receivedAt) =>
              parseMcpPromptsListPage({
                response,
                requestId,
                receivedAt,
                maxTtlMs: lease.registration.limits.maxDiscoveryTtlMs,
              }),
          })
        : unsupportedInventory<McpPromptDescriptor>("prompts");

      if (
        controller.signal.aborted ||
        generation !== record.generation ||
        !this.dependencies.isLeaseCurrent(lease)
      ) {
        throw new McpPrimitiveError(
          "mcp_source_refresh_stale",
          "MCP source refresh result is stale.",
        );
      }

      const sourceEpoch = record.nextSourceEpoch;
      const publishedAt = this.nowIso();
      const toolDescriptors = tools.inventory.items.map(
        (item) => item.descriptor,
      );
      const diagnostics = Object.freeze([
        ...tools.diagnostics,
        ...resources.diagnostics,
        ...resourceTemplates.diagnostics,
        ...prompts.diagnostics,
      ]);
      const fields = Object.freeze({
        schemaVersion: 1 as const,
        serverId: lease.registration.serverId,
        registrationFingerprint:
          lease.registration.registrationFingerprint,
        sourceEpoch,
        authorityBindingId: lease.registration.authorityBindingId,
        protocolRevision: lease.registration.protocolRevision,
        transportActivation: lease.activation,
        tools: replaceInventoryItems(tools.inventory, toolDescriptors),
        resources: resources.inventory,
        resourceTemplates: resourceTemplates.inventory,
        prompts: prompts.inventory,
        diagnostics,
        publishedAt,
      });
      const snapshot: McpSourceSnapshot = Object.freeze({
        ...fields,
        sourceSnapshotId: createMcpContractFingerprint(
          "agent-anything.mcp-source-snapshot.v1",
          fields,
        ),
      });
      const runtime: PublishedRuntime = Object.freeze({
        snapshot,
        toolsByName: new Map(
          tools.inventory.items.map((item) => [item.descriptor.name, item]),
        ),
      });
      record.nextSourceEpoch += 1;
      record.published = runtime;
      record.resourceCache.clear();
      return snapshot;
    } catch (error) {
      this.invalidateForProtocolRevision(lease, error);
      if (error instanceof McpPrimitiveError) throw error;
      if (controller.signal.aborted) {
        throw new McpPrimitiveError(
          "mcp_source_refresh_cancelled",
          "MCP source refresh was cancelled.",
        );
      }
      throw new McpPrimitiveError(
        "mcp_source_refresh_failed",
        error instanceof Error
          ? error.message
          : "MCP source refresh failed.",
      );
    }
  }

  private async consumeSubscription(input: {
    readonly record: SourceRecord;
    readonly runtime: PublishedRuntime;
    readonly lease: McpPrimitiveTransportLease;
    readonly source: McpSourceLookup;
    readonly subscriptionId: string;
    readonly requested: McpSubscriptionFilter;
    readonly stream: McpTransportResponseStream;
    readonly controller: AbortController;
    readonly resolveAcknowledged: (
      value: McpSubscriptionAcknowledgement,
    ) => void;
  }): Promise<void> {
    let acknowledged = false;
    let accepted: McpSubscriptionFilter | null = null;
    let finalResponse = false;
    const acknowledgementTimer = setTimeout(() => {
      input.controller.abort(new McpPrimitiveError(
        "mcp_subscription_lost",
        "MCP subscription acknowledgement timed out.",
      ));
    }, SUBSCRIPTION_ACK_TIMEOUT_MS);
    const iterator = input.stream.messages[Symbol.asyncIterator]();
    try {
      while (true) {
        let step: IteratorResult<unknown>;
        try {
          step = await nextMcpSubscriptionMessage(
            iterator,
            input.controller.signal,
          );
        } catch (error) {
          if (input.controller.signal.aborted && acknowledged) return;
          throw error;
        }
        if (step.done) break;
        const message = step.value;
        this.assertRuntimeCurrent(input.record, input.runtime, input.lease);
        if (isMcpJsonRpcResponse(message)) {
          if (!acknowledged) mcpSubscriptionInvalid(
            "MCP subscription closed before acknowledgement.",
          );
          parseMcpSubscriptionCompletion(message, input.subscriptionId);
          finalResponse = true;
          break;
        }
        const notification = parseMcpSubscriptionNotification(
          message,
          input.subscriptionId,
        );
        if (!acknowledged) {
          if (notification.method !==
            "notifications/subscriptions/acknowledged") {
            mcpSubscriptionInvalid(
              "MCP subscription must acknowledge before notifications.",
            );
          }
          accepted = validateMcpAcknowledgedFilter(
            notification.params.notifications,
            input.requested,
          );
          acknowledged = true;
          clearTimeout(acknowledgementTimer);
          input.resolveAcknowledged(Object.freeze({
            subscriptionId: input.subscriptionId,
            accepted,
          }));
          continue;
        }
        if (notification.method ===
          "notifications/subscriptions/acknowledged") {
          mcpSubscriptionInvalid(
            "MCP subscription acknowledged more than once.",
          );
        }
        const event = validateMcpSubscribedEvent(notification, accepted!);
        if (event.kind === "resource-updated") {
          invalidateMcpResourceCache(
            input.record.resourceCache,
            input.source.sourceEpoch,
            event.uri,
          );
          continue;
        }
        await this.refresh({
          serverId: input.source.serverId,
          registrationFingerprint: input.source.registrationFingerprint,
          signal: input.controller.signal,
        });
        input.controller.abort();
        return;
      }
      if (input.controller.signal.aborted) {
        if (!acknowledged) {
          throw mcpSubscriptionInterruption(input.controller.signal);
        }
        return;
      }
      if (!finalResponse) {
        throw new McpPrimitiveError(
          "mcp_subscription_lost",
          "MCP subscription stream ended without a final response.",
        );
      }
    } catch (error) {
      this.invalidateForProtocolRevision(input.lease, error);
      throw error;
    } finally {
      clearTimeout(acknowledgementTimer);
      if (input.controller.signal.aborted) {
        void iterator.return?.().catch(() => undefined);
      }
    }
  }

  private requireCurrentRuntime(input: McpSourceLookup): {
    readonly record: SourceRecord;
    readonly runtime: PublishedRuntime;
    readonly lease: McpPrimitiveTransportLease;
  } {
    const record = this.records.get(input.serverId);
    const runtime = record?.published;
    if (
      record === undefined ||
      runtime === null ||
      runtime === undefined ||
      runtime.snapshot.registrationFingerprint !==
        input.registrationFingerprint ||
      runtime.snapshot.sourceEpoch !== input.sourceEpoch
    ) {
      throw new McpPrimitiveError(
        "mcp_source_stale",
        "MCP source snapshot is unavailable or stale.",
      );
    }
    if (!sourceSnapshotFresh(runtime.snapshot, this.nowMs())) {
      throw new McpPrimitiveError(
        "mcp_primitive_cache_expired",
        "MCP source snapshot cache has expired.",
      );
    }
    const lease = this.requireActiveLease(
      input.serverId,
      input.registrationFingerprint,
    );
    if (
      lease.activation.activationId !==
        runtime.snapshot.transportActivation.activationId
    ) {
      throw new McpPrimitiveError(
        "mcp_source_stale",
        "MCP source snapshot belongs to a stale transport activation.",
      );
    }
    return { record, runtime, lease };
  }

  private assertRuntimeCurrent(
    record: SourceRecord,
    runtime: PublishedRuntime,
    lease: McpPrimitiveTransportLease,
  ): void {
    if (
      record.published !== runtime ||
      !this.dependencies.isLeaseCurrent(lease)
    ) {
      throw new McpPrimitiveError(
        "mcp_source_stale",
        "MCP operation result belongs to a stale source snapshot.",
      );
    }
  }

  private requireActiveLease(
    serverId: string,
    registrationFingerprint: string,
  ): McpPrimitiveTransportLease {
    const lease = this.dependencies.getActiveLease(
      serverId,
      registrationFingerprint,
    );
    if (lease === null) {
      throw new McpPrimitiveError(
        "mcp_source_unavailable",
        `MCP server '${serverId}' has no active transport.`,
      );
    }
    return lease;
  }

  private record(serverId: string): SourceRecord {
    let record = this.records.get(serverId);
    if (record === undefined) {
      record = {
        nextSourceEpoch: 1,
        generation: 0,
        published: null,
        refresh: null,
        resourceCache: new Map(),
        subscriptions: new Set(),
      };
      this.records.set(serverId, record);
    }
    return record;
  }

  private nextId(subject: string): string {
    return validateMcpToken(
      this.dependencies.createId(),
      `MCP ${subject} id`,
      512,
    );
  }

  private nowMs(): number {
    const value = this.dependencies.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new TypeError("MCP primitive clock returned an invalid Date.");
    }
    return value.getTime();
  }

  private nowIso(): string {
    return new Date(this.nowMs()).toISOString();
  }

  private invalidateForProtocolRevision(
    lease: McpPrimitiveTransportLease,
    error: unknown,
  ): void {
    if (
      error instanceof McpOperationError &&
      error.code === "mcp_protocol_version_unsupported"
    ) {
      this.dependencies.invalidateLease(lease, error);
    }
  }
}

function linkAbortSignal(
  source: AbortSignal | undefined,
  target: AbortController,
): () => void {
  if (source === undefined) return () => undefined;
  const abort = () => target.abort(source.reason);
  if (source.aborted) {
    abort();
    return () => undefined;
  }
  source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

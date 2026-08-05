
import {
  deriveMcpToolParameterHeaders,
} from "./McpHeaders.js";
import {
  createMcpContractFingerprint,
  type McpJsonObject,
  snapshotMcpJsonObject,
  validateMcpText,
  validateMcpToken,
} from "./McpJson.js";
import type { McpActivationSnapshot } from "./McpLifecycle.js";
import {
  parseMcpPromptGetResult,
  parseMcpPromptsListPage,
  parseMcpResourceReadResult,
  parseMcpResourcesListPage,
  parseMcpResourceTemplatesListPage,
  parseMcpToolCallResult,
  parseMcpToolsListPage,
  type McpParsedListPage,
  type McpParsedTool,
} from "./McpPrimitiveProtocol.js";
import type {
  McpPrimitiveCache,
  McpPrimitiveDiagnostic,
  McpPrimitiveInventory,
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
  McpSubscriptionEvent,
  McpSubscriptionFilter,
  McpSubscriptionHandle,
  McpToolDescriptor,
  RefreshMcpSourceInput,
  StartMcpSubscriptionInput,
} from "./McpPrimitives.js";
import {
  McpOperationError,
  parseMcpOperationResponse,
} from "./McpProtocol.js";
import type { McpServerRegistration } from "./McpRegistration.js";
import type {
  McpToolCallInput,
  McpToolCallResult,
} from "./McpToolOperationPort.js";
import type { McpTransportResponseStream } from "./McpTransport.js";

const MAX_LIST_PAGES = 64;
const MAX_INVENTORY_ITEMS = 4_096;
const SUBSCRIPTION_ACK_TIMEOUT_MS = 10_000;
const SUBSCRIPTION_ID_META_KEY =
  "io.modelcontextprotocol/subscriptionId";

export interface McpPrimitiveTransportLease {
  readonly registration: McpServerRegistration;
  readonly activation: McpActivationSnapshot;
}

export interface McpPrimitiveCoordinatorDependencies {
  getActiveLease(
    serverId: string,
    registrationFingerprint: string,
  ): McpPrimitiveTransportLease | null;
  isLeaseCurrent(lease: McpPrimitiveTransportLease): boolean;
  request(input: {
    readonly lease: McpPrimitiveTransportLease;
    readonly requestId: string;
    readonly method: string;
    readonly params: McpJsonObject;
    readonly name?: string;
    readonly parameterHeaders?: Readonly<Record<string, string>>;
    readonly sourceEpoch: number | null;
    readonly signal?: AbortSignal;
  }): Promise<unknown>;
  openStream(input: {
    readonly lease: McpPrimitiveTransportLease;
    readonly requestId: string;
    readonly method: "subscriptions/listen";
    readonly params: McpJsonObject;
    readonly sourceEpoch: number;
    readonly signal: AbortSignal;
  }): Promise<McpTransportResponseStream>;
  invalidateLease(
    lease: McpPrimitiveTransportLease,
    error: McpOperationError,
  ): void;
  now(): Date;
  createId(): string;
}

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

export class McpPrimitiveError extends Error {
  constructor(
    readonly code:
      | "mcp_source_unavailable"
      | "mcp_source_stale"
      | "mcp_source_refresh_failed"
      | "mcp_source_refresh_cancelled"
      | "mcp_source_refresh_stale"
      | "mcp_inventory_ambiguous"
      | "mcp_inventory_limit_exceeded"
      | "mcp_primitive_not_found"
      | "mcp_primitive_cache_expired"
      | "mcp_tool_input_invalid"
      | "mcp_prompt_arguments_invalid"
      | "mcp_subscription_invalid"
      | "mcp_subscription_lost"
      | "mcp_operation_cancelled"
      | "mcp_operation_timeout"
      | "mcp_operation_failed",
    message: string,
  ) {
    super(message);
    this.name = "McpPrimitiveError";
  }
}

export class McpPrimitiveCoordinator {
  private readonly records = new Map<string, SourceRecord>();

  constructor(private readonly dependencies: McpPrimitiveCoordinatorDependencies) {}

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
    const uri = validateResourceUri(input.uri);
    const cacheKey = resourceCacheKey(runtime.snapshot, uri);
    const cached = getFreshResourceCache(
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
    const args = validatePromptArguments(prompt, input.arguments ?? {});
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
    const requested = validateSubscriptionFilter(
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
          notifications: subscriptionFilterToJson(requested),
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
        ? await this.loadInventory({
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
        ? await this.loadInventory({
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
        ? await this.loadInventory({
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
        ? await this.loadInventory({
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

  private async loadInventory<T, D>(input: {
    readonly lease: McpPrimitiveTransportLease;
    readonly sourceEpoch: number | null;
    readonly method:
      | "tools/list"
      | "resources/list"
      | "resources/templates/list"
      | "prompts/list";
    readonly signal: AbortSignal;
    readonly identity: (item: T) => string;
    readonly descriptor: (item: T) => D;
    readonly parser: (
      response: unknown,
      requestId: string,
      receivedAt: string,
    ) => McpParsedListPage<T>;
  }): Promise<{
    readonly inventory: McpPrimitiveInventory<T>;
    readonly diagnostics: readonly McpPrimitiveDiagnostic[];
  }> {
    const items: T[] = [];
    const diagnostics: McpPrimitiveDiagnostic[] = [];
    const caches: McpPrimitiveCache[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (let pageIndex = 0; pageIndex < MAX_LIST_PAGES; pageIndex += 1) {
      const requestId = this.nextId(`${input.method} request`);
      const response = await this.dependencies.request({
        lease: input.lease,
        requestId,
        method: input.method,
        params: cursor === null
          ? Object.freeze({})
          : Object.freeze({ cursor }),
        sourceEpoch: input.sourceEpoch,
        signal: input.signal,
      });
      const page = input.parser(response, requestId, this.nowIso());
      items.push(...page.items);
      diagnostics.push(...page.diagnostics);
      caches.push(page.cache);
      if (items.length > MAX_INVENTORY_ITEMS) {
        throw new McpPrimitiveError(
          "mcp_inventory_limit_exceeded",
          `MCP ${input.method} inventory exceeds the item limit.`,
        );
      }
      if (page.nextCursor === null) break;
      if (cursors.has(page.nextCursor)) {
        throw new McpPrimitiveError(
          "mcp_inventory_ambiguous",
          `MCP ${input.method} pagination contains a cursor cycle.`,
        );
      }
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
      if (pageIndex === MAX_LIST_PAGES - 1) {
        throw new McpPrimitiveError(
          "mcp_inventory_limit_exceeded",
          `MCP ${input.method} exceeds the page limit.`,
        );
      }
    }

    const identities = new Set<string>();
    for (const item of items) {
      const identity = input.identity(item);
      if (identities.has(identity)) {
        throw new McpPrimitiveError(
          "mcp_inventory_ambiguous",
          `MCP ${input.method} contains duplicate identity '${identity}'.`,
        );
      }
      identities.add(identity);
    }
    items.sort((left, right) =>
      compareStrings(input.identity(left), input.identity(right))
    );
    const cache = aggregateCaches(caches);
    const frozenItems = Object.freeze(items);
    const fingerprintItems = frozenItems.map(input.descriptor);
    const inventory: McpPrimitiveInventory<T> = Object.freeze({
      advertised: true,
      snapshotId: createMcpContractFingerprint(
        "agent-anything.mcp-primitive-inventory.v1",
        Object.freeze({
          method: input.method,
          items: fingerprintItems,
          cache,
        }),
      ),
      items: frozenItems,
      cache,
    });
    return Object.freeze({
      inventory,
      diagnostics: Object.freeze(diagnostics),
    });
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
          step = await nextSubscriptionMessage(
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
        if (isJsonRpcResponse(message)) {
          if (!acknowledged) subscriptionInvalid(
            "MCP subscription closed before acknowledgement.",
          );
          parseSubscriptionCompletion(message, input.subscriptionId);
          finalResponse = true;
          break;
        }
        const notification = parseSubscriptionNotification(
          message,
          input.subscriptionId,
        );
        if (!acknowledged) {
          if (notification.method !==
            "notifications/subscriptions/acknowledged") {
            subscriptionInvalid(
              "MCP subscription must acknowledge before notifications.",
            );
          }
          accepted = validateAcknowledgedFilter(
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
          subscriptionInvalid("MCP subscription acknowledged more than once.");
        }
        const event = validateSubscribedEvent(notification, accepted!);
        if (event.kind === "resource-updated") {
          invalidateResourceCache(
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
          throw subscriptionInterruption(input.controller.signal);
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

function unsupportedInventory<T>(
  identity: string,
): {
  readonly inventory: McpPrimitiveInventory<T>;
  readonly diagnostics: readonly McpPrimitiveDiagnostic[];
} {
  const inventory = Object.freeze({
    advertised: false,
    snapshotId: createMcpContractFingerprint(
      "agent-anything.mcp-primitive-inventory.v1",
      Object.freeze({ identity, advertised: false }),
    ),
    items: Object.freeze([]),
    cache: null,
  });
  return Object.freeze({
    inventory,
    diagnostics: Object.freeze([]),
  });
}

function replaceInventoryItems<T, U>(
  inventory: McpPrimitiveInventory<T>,
  items: readonly U[],
): McpPrimitiveInventory<U> {
  return Object.freeze({
    advertised: inventory.advertised,
    snapshotId: inventory.snapshotId,
    items: Object.freeze([...items]),
    cache: inventory.cache,
  });
}

function aggregateCaches(
  caches: readonly McpPrimitiveCache[],
): McpPrimitiveCache {
  if (caches.length === 0) {
    throw new McpPrimitiveError(
      "mcp_source_refresh_failed",
      "MCP inventory did not produce cache metadata.",
    );
  }
  const receivedAt = caches[0]!.receivedAt;
  const receivedAtMs = Date.parse(receivedAt);
  const expiresAtMs = Math.min(
    ...caches.map((cache) => Date.parse(cache.expiresAt)),
  );
  return Object.freeze({
    ttlMs: Math.max(0, expiresAtMs - receivedAtMs),
    scope: caches.some((cache) => cache.scope === "private")
      ? "private"
      : "public",
    receivedAt,
    expiresAt: new Date(expiresAtMs).toISOString(),
  });
}

function requireFreshInventory(
  inventory: McpPrimitiveInventory<unknown>,
  nowMs: number,
  label: string,
): void {
  if (!inventory.advertised || inventory.cache === null) {
    throw new McpPrimitiveError(
      "mcp_source_unavailable",
      `MCP ${label} capability is not advertised.`,
    );
  }
  if (Date.parse(inventory.cache.expiresAt) <= nowMs) {
    throw new McpPrimitiveError(
      "mcp_primitive_cache_expired",
      `MCP ${label} inventory cache has expired.`,
    );
  }
}

function sourceSnapshotFresh(
  snapshot: McpSourceSnapshot,
  nowMs: number,
): boolean {
  if (
    Date.parse(snapshot.transportActivation.discovery.cache.expiresAt) <= nowMs
  ) {
    return false;
  }
  return [
    snapshot.tools,
    snapshot.resources,
    snapshot.resourceTemplates,
    snapshot.prompts,
  ].every((inventory) =>
    !inventory.advertised ||
    (
      inventory.cache !== null &&
      Date.parse(inventory.cache.expiresAt) > nowMs
    )
  );
}

function validatePromptArguments(
  prompt: McpPromptDescriptor,
  input: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  ) {
    throw new McpPrimitiveError(
      "mcp_prompt_arguments_invalid",
      "MCP Prompt arguments must be a plain object.",
    );
  }
  const descriptors = new Map(
    prompt.arguments.map((argument) => [argument.name, argument]),
  );
  const output: Record<string, string> = {};
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !descriptors.has(key)) {
      throw new McpPrimitiveError(
        "mcp_prompt_arguments_invalid",
        "MCP Prompt arguments contain an unknown name.",
      );
    }
    const property = Object.getOwnPropertyDescriptor(input, key);
    if (
      property === undefined ||
      property.get !== undefined ||
      property.set !== undefined ||
      !property.enumerable
    ) {
      throw new McpPrimitiveError(
        "mcp_prompt_arguments_invalid",
        "MCP Prompt arguments must use enumerable data properties.",
      );
    }
    output[key] = validateMcpText(
      input[key],
      `prompt.arguments.${key}`,
      65_536,
    );
  }
  for (const argument of prompt.arguments) {
    if (argument.required && !Object.hasOwn(output, argument.name)) {
      throw new McpPrimitiveError(
        "mcp_prompt_arguments_invalid",
        `MCP Prompt argument '${argument.name}' is required.`,
      );
    }
  }
  return Object.freeze(output);
}

function validateSubscriptionFilter(
  input: McpSubscriptionFilter,
  snapshot: McpSourceSnapshot,
): McpSubscriptionFilter {
  const capabilities =
    snapshot.transportActivation.discovery.serverCapabilities.capabilities;
  const tools = readCapability(capabilities, "tools");
  const resources = readCapability(capabilities, "resources");
  const prompts = readCapability(capabilities, "prompts");
  const accepted: {
    toolsListChanged?: true;
    promptsListChanged?: true;
    resourcesListChanged?: true;
    resourceSubscriptions?: readonly string[];
  } = {};
  if (input.toolsListChanged === true) {
    requireCapabilityFlag(tools, "listChanged", "toolsListChanged");
    accepted.toolsListChanged = true;
  }
  if (input.promptsListChanged === true) {
    requireCapabilityFlag(prompts, "listChanged", "promptsListChanged");
    accepted.promptsListChanged = true;
  }
  if (input.resourcesListChanged === true) {
    requireCapabilityFlag(resources, "listChanged", "resourcesListChanged");
    accepted.resourcesListChanged = true;
  }
  if (input.resourceSubscriptions !== undefined) {
    requireCapabilityFlag(resources, "subscribe", "resourceSubscriptions");
    if (
      !Array.isArray(input.resourceSubscriptions) ||
      input.resourceSubscriptions.length === 0 ||
      input.resourceSubscriptions.length > 256
    ) {
      subscriptionInvalid(
        "MCP resource subscription filter must be bounded and non-empty.",
      );
    }
    const values = new Set(
      input.resourceSubscriptions.map(validateResourceUri),
    );
    accepted.resourceSubscriptions = Object.freeze([...values].sort());
  }
  if (Object.keys(accepted).length === 0) {
    subscriptionInvalid("MCP subscription filter cannot be empty.");
  }
  return Object.freeze(accepted);
}

function validateAcknowledgedFilter(
  input: unknown,
  requested: McpSubscriptionFilter,
): McpSubscriptionFilter {
  const candidate = parseSubscriptionFilter(input);
  if (
    candidate.toolsListChanged === true &&
    requested.toolsListChanged !== true ||
    candidate.promptsListChanged === true &&
    requested.promptsListChanged !== true ||
    candidate.resourcesListChanged === true &&
    requested.resourcesListChanged !== true
  ) {
    subscriptionInvalid(
      "MCP subscription acknowledgement exceeds the requested filter.",
    );
  }
  const requestedUris = new Set(requested.resourceSubscriptions ?? []);
  if (
    candidate.resourceSubscriptions?.some(
      (uri) => !requestedUris.has(uri),
    )
  ) {
    subscriptionInvalid(
      "MCP subscription acknowledgement contains an unrequested Resource URI.",
    );
  }
  return candidate;
}

function parseSubscriptionFilter(input: unknown): McpSubscriptionFilter {
  const value = snapshotMcpJsonObject(input, "subscription.notifications");
  const allowed = new Set([
    "toolsListChanged",
    "promptsListChanged",
    "resourcesListChanged",
    "resourceSubscriptions",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      subscriptionInvalid("MCP subscription filter contains an unknown field.");
    }
  }
  const output: {
    toolsListChanged?: true;
    promptsListChanged?: true;
    resourcesListChanged?: true;
    resourceSubscriptions?: readonly string[];
  } = {};
  for (
    const field of [
      "toolsListChanged",
      "promptsListChanged",
      "resourcesListChanged",
    ] as const
  ) {
    if (value[field] !== undefined) {
      if (value[field] !== true) {
        subscriptionInvalid(
          "MCP acknowledged filter boolean values must be true.",
        );
      }
      output[field] = true;
    }
  }
  if (value.resourceSubscriptions !== undefined) {
    if (!Array.isArray(value.resourceSubscriptions)) {
      subscriptionInvalid("MCP acknowledged Resource filter is invalid.");
    }
    output.resourceSubscriptions = Object.freeze(
      value.resourceSubscriptions.map(validateResourceUri).sort(),
    );
  }
  return Object.freeze(output);
}

function subscriptionFilterToJson(
  input: McpSubscriptionFilter,
): McpJsonObject {
  return Object.freeze({
    ...(input.toolsListChanged === true
      ? { toolsListChanged: true }
      : {}),
    ...(input.promptsListChanged === true
      ? { promptsListChanged: true }
      : {}),
    ...(input.resourcesListChanged === true
      ? { resourcesListChanged: true }
      : {}),
    ...(input.resourceSubscriptions === undefined
      ? {}
      : { resourceSubscriptions: Object.freeze([...input.resourceSubscriptions]) }),
  });
}

function readCapability(
  capabilities: McpJsonObject,
  name: string,
): McpJsonObject | null {
  const value = capabilities[name];
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as McpJsonObject
    : null;
}

function requireCapabilityFlag(
  capability: McpJsonObject | null,
  flag: string,
  filterName: string,
): void {
  if (capability?.[flag] !== true) {
    subscriptionInvalid(
      `MCP server did not advertise support for '${filterName}'.`,
    );
  }
}

function parseSubscriptionNotification(
  input: unknown,
  subscriptionId: string,
): {
  readonly method: string;
  readonly params: McpJsonObject;
} {
  const message = snapshotMcpJsonObject(input, "subscription.message");
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    subscriptionInvalid("MCP subscription notification is invalid.");
  }
  const params: McpJsonObject = message.params === undefined
    ? Object.freeze({})
    : snapshotMcpJsonObject(message.params, "subscription.message.params");
  const meta = snapshotMcpJsonObject(
    params._meta,
    "subscription.message.params._meta",
  );
  if (meta[SUBSCRIPTION_ID_META_KEY] !== subscriptionId) {
    subscriptionInvalid("MCP subscription notification is uncorrelated.");
  }
  return Object.freeze({ method: message.method, params });
}

function validateSubscribedEvent(
  input: {
    readonly method: string;
    readonly params: McpJsonObject;
  },
  accepted: McpSubscriptionFilter,
): McpSubscriptionEvent {
  switch (input.method) {
    case "notifications/tools/list_changed":
      if (accepted.toolsListChanged !== true) break;
      return Object.freeze({ kind: "tools-list-changed" });
    case "notifications/prompts/list_changed":
      if (accepted.promptsListChanged !== true) break;
      return Object.freeze({ kind: "prompts-list-changed" });
    case "notifications/resources/list_changed":
      if (accepted.resourcesListChanged !== true) break;
      return Object.freeze({ kind: "resources-list-changed" });
    case "notifications/resources/updated": {
      if (accepted.resourceSubscriptions === undefined) break;
      const uri = validateResourceUri(input.params.uri);
      if (!accepted.resourceSubscriptions.includes(uri)) break;
      return Object.freeze({ kind: "resource-updated", uri });
    }
  }
  return subscriptionInvalid(
    "MCP subscription delivered an unrequested notification.",
  );
}

function parseSubscriptionCompletion(
  input: unknown,
  subscriptionId: string,
): void {
  const result = parseMcpOperationResponse({
    response: input,
    requestId: subscriptionId,
    operation: "subscriptions/listen",
  });
  if (Object.keys(result).some((key) => key !== "_meta")) {
    subscriptionInvalid("MCP subscription completion result is invalid.");
  }
  const meta = snapshotMcpJsonObject(
    result._meta,
    "subscription.completion._meta",
  );
  if (meta[SUBSCRIPTION_ID_META_KEY] !== subscriptionId) {
    subscriptionInvalid("MCP subscription completion is uncorrelated.");
  }
}

function isJsonRpcResponse(input: unknown): boolean {
  return input !== null &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    Object.hasOwn(input, "id");
}

function invalidateResourceCache(
  cache: Map<string, McpResourceReadResult>,
  sourceEpoch: number,
  uri: string,
): void {
  const marker = `\u0000resources/read\u0000${uri}\u0000`;
  for (const key of cache.keys()) {
    if (key.startsWith(`${sourceEpoch}\u0000`) && key.includes(marker)) {
      cache.delete(key);
    }
  }
}

function resourceCacheKey(
  source: McpSourceSnapshot,
  uri: string,
): string {
  return [
    source.sourceEpoch,
    source.registrationFingerprint,
    source.authorityBindingId,
    "resources/read",
    uri,
  ].join("\u0000");
}

function getFreshResourceCache(
  cache: Map<string, McpResourceReadResult>,
  key: string,
  nowMs: number,
): McpResourceReadResult | null {
  for (const scope of ["private", "public"] as const) {
    const scopedKey = `${key}\u0000${scope}`;
    const candidate = cache.get(scopedKey);
    if (candidate === undefined) continue;
    if (Date.parse(candidate.cache.expiresAt) > nowMs) return candidate;
    cache.delete(scopedKey);
  }
  return null;
}

function validateResourceUri(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > 8_192 ||
    /[\u0000-\u001f\u007f]/.test(input)
  ) {
    throw new McpPrimitiveError(
      "mcp_primitive_not_found",
      "MCP Resource URI is invalid.",
    );
  }
  try {
    new URL(input);
  } catch {
    throw new McpPrimitiveError(
      "mcp_primitive_not_found",
      "MCP Resource URI must be absolute.",
    );
  }
  return input;
}

function subscriptionInvalid(message: string): never {
  throw new McpPrimitiveError("mcp_subscription_invalid", message);
}

function subscriptionInterruption(signal: AbortSignal): Error {
  return signal.reason instanceof McpPrimitiveError
    ? signal.reason
    : new McpPrimitiveError(
      "mcp_operation_cancelled",
      "MCP subscription was cancelled before acknowledgement.",
    );
}

async function nextSubscriptionMessage(
  iterator: AsyncIterator<unknown>,
  signal: AbortSignal,
): Promise<IteratorResult<unknown>> {
  if (signal.aborted) throw subscriptionInterruption(signal);
  return new Promise<IteratorResult<unknown>>((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () =>
      settle(() => reject(subscriptionInterruption(signal)));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(iterator.next()).then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error)),
    );
  });
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

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

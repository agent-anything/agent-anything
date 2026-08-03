import { describe, expect, it, vi } from "vitest";
import { McpOperationError } from "./McpProtocol.js";
import { McpRegistry } from "./McpRegistry.js";
import {
  MCP_PROTOCOL_REVISION,
  type McpServerRegistration,
} from "./McpRegistration.js";
import type {
  McpTransportCloseRequest,
  McpTransportClosure,
  McpTransportConnection,
  McpTransportConnectionIdentity,
  McpTransportConnector,
  McpTransportConnectRequest,
  McpTransportOperationControl,
  McpTransportRequest,
  McpTransportResponseStream,
} from "./McpTransport.js";

const NOW = "2026-08-03T04:00:00.000Z";
const SUBSCRIPTION_ID_META_KEY =
  "io.modelcontextprotocol/subscriptionId";

describe("MCP primitive source publication", () => {
  it("publishes one complete source epoch and excludes malformed descriptors safely", async () => {
    const harness = await activatedHarness();
    harness.server.failPromptList = true;

    await expect(refresh(harness)).rejects.toMatchObject({
      code: "mcp_source_refresh_failed",
    });
    expect(harness.registry.getSourceSnapshot("server-main")).toBeNull();

    harness.server.failPromptList = false;
    const source = await refresh(harness);

    expect(source.sourceEpoch).toBe(1);
    expect(source.transportActivation.activationGeneration).toBe(1);
    expect(source.tools.items.map((tool) => tool.name)).toEqual([
      "echo",
      "inspect",
    ]);
    expect(source.resources.items).toHaveLength(1);
    expect(source.resourceTemplates.items).toHaveLength(1);
    expect(source.prompts.items).toHaveLength(1);
    expect(source.diagnostics).toEqual([
      expect.objectContaining({
        primitive: "tool",
        itemIdentity: "invalidRoot",
        code: "mcp_primitive_invalid",
        message: "MCP tool definition was excluded because it is invalid.",
      }),
    ]);
    expect(Object.isFrozen(source)).toBe(true);
    expect(source.sourceSnapshotId).toMatch(/^sha256:[0-9a-f]{64}$/);

    const toolListRequests = harness.connection.requests.filter(
      ({ request }) => request.message.method === "tools/list",
    );
    expect(toolListRequests).toHaveLength(4);
    expect(
      toolListRequests.some(
        ({ request }) => request.message.params.cursor === "opaque=next page",
      ),
    ).toBe(true);
    expect(
      toolListRequests.every(({ control }) => control.sourceEpoch === null),
    ).toBe(true);
  });

  it("validates Tool input and output while deriving exact HTTP parameter headers", async () => {
    const harness = await readyHarness();
    const source = lookup(harness);
    const callsBefore = harness.server.toolCallCount;

    await expect(harness.registry.callTool({
      source,
      toolName: "echo",
      toolCallId: "call-invalid",
      input: { message: 42 },
    })).rejects.toMatchObject({ code: "mcp_tool_input_invalid" });
    expect(harness.server.toolCallCount).toBe(callsBefore);

    const result = await harness.registry.callTool({
      source,
      toolName: "echo",
      toolCallId: "call-valid",
      input: { message: "你好" },
    });

    expect(result).toMatchObject({
      toolCallId: "call-valid",
      toolName: "echo",
      isError: false,
      output: {
        structuredContent: { echo: "你好" },
      },
    });
    const request = harness.connection.requests.findLast(
      ({ request }) => request.message.method === "tools/call",
    );
    expect(request?.request.httpHeaders).toMatchObject({
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/call",
      "Mcp-Name": "echo",
      "Mcp-Param-Message": "=?base64?5L2g5aW9?=",
    });
    expect(request?.request.message.params).toMatchObject({
      name: "echo",
      arguments: { message: "你好" },
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      },
    });
    expect(request?.control.sourceEpoch).toBe(1);

    harness.server.invalidToolOutput = true;
    await expect(harness.registry.callTool({
      source,
      toolName: "echo",
      toolCallId: "call-output-invalid",
      input: { message: "valid" },
    })).rejects.toMatchObject({
      code: "mcp_operation_response_invalid",
    });
    expect(harness.registry.resolveSource(source)).not.toBeNull();
  });

  it("keeps Resource and Prompt operations distinct and partitions Resource cache", async () => {
    const harness = await readyHarness();
    const source = lookup(harness);

    const first = await harness.registry.readResource({
      source,
      uri: "memory://docs/guide",
    });
    const second = await harness.registry.readResource({
      source,
      uri: "memory://docs/guide",
    });
    expect(first).toBe(second);
    expect(first.contents[0]).toMatchObject({
      kind: "text",
      text: "Guide content",
    });
    expect(first.cache.scope).toBe("private");
    expect(harness.server.resourceReadCount).toBe(1);

    await expect(harness.registry.getPrompt({
      source,
      name: "review",
      arguments: {},
    })).rejects.toMatchObject({ code: "mcp_prompt_arguments_invalid" });
    expect(harness.server.promptGetCount).toBe(0);

    const prompt = await harness.registry.getPrompt({
      source,
      name: "review",
      arguments: { topic: "MCP" },
    });
    expect(prompt.messages).toEqual([
      {
        role: "user",
        content: {
          type: "text",
          text: "Review MCP",
        },
      },
    ]);
    expect(harness.server.promptGetCount).toBe(1);
    expect(harness.source.resources.items[0]).not.toHaveProperty("inputSchema");
    expect(harness.source.prompts.items[0]).not.toHaveProperty("inputSchema");
  });

  it("retains the prior source after a failed refresh and advances only on commit", async () => {
    const harness = await readyHarness();
    const first = harness.source;
    harness.server.catalogVersion = 2;
    harness.server.failPromptList = true;

    await expect(refresh(harness)).rejects.toMatchObject({
      code: "mcp_source_refresh_failed",
    });
    expect(harness.registry.getSourceSnapshot("server-main")).toBe(first);
    expect(harness.registry.resolveSource(lookup(harness))).toBe(first);

    harness.server.failPromptList = false;
    const second = await refresh(harness);
    expect(second.sourceEpoch).toBe(2);
    expect(second.transportActivation.activationGeneration).toBe(1);
    expect(second.tools.items[0]?.title).toBe("Echo v2");
    expect(harness.registry.resolveSource(lookup(harness))).toBeNull();
    expect(harness.registry.resolveSource(sourceLookup(second))).toBe(second);

    const refreshRequests = harness.connection.requests.filter(
      ({ request, control }) =>
        request.message.method.endsWith("/list") &&
        control.sourceEpoch === 1,
    );
    expect(refreshRequests.length).toBeGreaterThan(0);
  });

  it("acknowledges filtered subscriptions before invalidation and atomically refreshes list changes", async () => {
    const harness = await readyHarness();
    const source = lookup(harness);
    await harness.registry.readResource({
      source,
      uri: "memory://docs/guide",
    });

    const handle = await harness.registry.startSubscription({
      source,
      filter: {
        toolsListChanged: true,
        resourceSubscriptions: ["memory://docs/guide"],
      },
    });
    const queue = harness.server.lastSubscription!;
    queue.push(subscriptionNotification(
      handle.subscriptionId,
      "notifications/subscriptions/acknowledged",
      {
        notifications: {
          toolsListChanged: true,
          resourceSubscriptions: ["memory://docs/guide"],
        },
      },
    ));
    await expect(handle.acknowledged).resolves.toEqual({
      subscriptionId: handle.subscriptionId,
      accepted: {
        toolsListChanged: true,
        resourceSubscriptions: ["memory://docs/guide"],
      },
    });

    queue.push(subscriptionNotification(
      handle.subscriptionId,
      "notifications/resources/updated",
      { uri: "memory://docs/guide" },
    ));
    await queue.waitUntilConsumed(2);
    await flushMicrotasks();
    await harness.registry.readResource({
      source,
      uri: "memory://docs/guide",
    });
    expect(harness.server.resourceReadCount).toBe(2);

    harness.server.catalogVersion = 2;
    queue.push(subscriptionNotification(
      handle.subscriptionId,
      "notifications/tools/list_changed",
      {},
    ));
    await expect(handle.completed).resolves.toBeUndefined();
    const refreshed = harness.registry.getSourceSnapshot("server-main");
    expect(refreshed?.sourceEpoch).toBe(2);
    expect(refreshed?.tools.items[0]?.title).toBe("Echo v2");
    expect(harness.registry.resolveSource(source)).toBeNull();
  });

  it("rejects notifications before acknowledgement and accepts a correlated empty graceful result", async () => {
    const invalid = await readyHarness();
    const invalidHandle = await invalid.registry.startSubscription({
      source: lookup(invalid),
      filter: { toolsListChanged: true },
    });
    const invalidAcknowledgement = expect(
      invalidHandle.acknowledged,
    ).rejects.toMatchObject({ code: "mcp_subscription_invalid" });
    const invalidCompletion = expect(
      invalidHandle.completed,
    ).rejects.toMatchObject({ code: "mcp_subscription_invalid" });
    invalid.server.lastSubscription!.push(subscriptionNotification(
      invalidHandle.subscriptionId,
      "notifications/tools/list_changed",
      {},
    ));
    await invalidAcknowledgement;
    await invalidCompletion;

    const graceful = await readyHarness();
    const gracefulHandle = await graceful.registry.startSubscription({
      source: lookup(graceful),
      filter: { toolsListChanged: true },
    });
    const queue = graceful.server.lastSubscription!;
    queue.push(subscriptionNotification(
      gracefulHandle.subscriptionId,
      "notifications/subscriptions/acknowledged",
      { notifications: { toolsListChanged: true } },
    ));
    await gracefulHandle.acknowledged;
    queue.push({
      jsonrpc: "2.0",
      id: gracefulHandle.subscriptionId,
      result: {
        _meta: {
          [SUBSCRIPTION_ID_META_KEY]: gracefulHandle.subscriptionId,
        },
      },
    });
    await expect(gracefulHandle.completed).resolves.toBeUndefined();
  });

  it("rejects Resource updates outside the acknowledged URI filter", async () => {
    const harness = await readyHarness();
    const source = lookup(harness);
    await harness.registry.readResource({
      source,
      uri: "memory://docs/guide",
    });

    const handle = await harness.registry.startSubscription({
      source,
      filter: {
        resourceSubscriptions: ["memory://docs/guide"],
      },
    });
    const queue = harness.server.lastSubscription!;
    queue.push(subscriptionNotification(
      handle.subscriptionId,
      "notifications/subscriptions/acknowledged",
      {
        notifications: {
          resourceSubscriptions: ["memory://docs/guide"],
        },
      },
    ));
    await handle.acknowledged;

    queue.push(subscriptionNotification(
      handle.subscriptionId,
      "notifications/resources/updated",
      { uri: "memory://docs/unrequested" },
    ));
    await expect(handle.completed).rejects.toMatchObject({
      code: "mcp_subscription_invalid",
    });

    await harness.registry.readResource({
      source,
      uri: "memory://docs/guide",
    });
    expect(harness.server.resourceReadCount).toBe(1);
  });

  it("propagates cancellation and invalidates activation on protocol revision rejection", async () => {
    const cancelled = await readyHarness();
    const cancellation = new AbortController();
    cancelled.server.pendingToolCall = true;
    const call = cancelled.registry.callTool({
      source: lookup(cancelled),
      toolName: "echo",
      toolCallId: "call-cancelled",
      input: { message: "wait" },
      signal: cancellation.signal,
    });
    await vi.waitFor(() => {
      expect(cancelled.server.toolCallCount).toBe(1);
    });
    cancellation.abort();
    await expect(call).rejects.toMatchObject({
      code: "mcp_operation_cancelled",
    });
    const pendingRequest = cancelled.connection.requests.findLast(
      ({ request }) => request.message.method === "tools/call",
    );
    expect(pendingRequest?.control.signal.aborted).toBe(true);
    expect(cancelled.registry.resolveSource(lookup(cancelled))).not.toBeNull();

    const rejected = await readyHarness();
    rejected.server.rejectProtocolRevision = true;
    await expect(rejected.registry.callTool({
      source: lookup(rejected),
      toolName: "echo",
      toolCallId: "call-rejected",
      input: { message: "fail" },
    })).rejects.toBeInstanceOf(McpOperationError);
    expect(rejected.registry.getState("server-main")).toMatchObject({
      status: "failed",
      failure: { code: "mcp_protocol_version_unsupported" },
    });
    expect(rejected.registry.getActiveSnapshot("server-main")).toBeNull();
    expect(rejected.registry.resolveSource(lookup(rejected))).toBeNull();
  });
});

interface Harness {
  readonly registry: McpRegistry;
  readonly registration: McpServerRegistration;
  readonly server: PrimitiveServer;
  readonly connection: PrimitiveConnection;
  source: Awaited<ReturnType<McpRegistry["refreshSource"]>>;
}

async function activatedHarness(): Promise<Harness> {
  const server = new PrimitiveServer();
  const connector = new PrimitiveConnector(server);
  let sequence = 0;
  const registry = new McpRegistry({
    connector,
    now: () => new Date(NOW),
    createId: () => `id-${++sequence}`,
  });
  const registration = registry.register({
    serverId: "server-main",
    displayName: "Main MCP Server",
    registrationRevision: "revision-1",
    authorityBindingId: "authority-main",
    transport: {
      kind: "streamable-http",
      bindingId: "binding-main",
      bindingRevision: "binding-1",
      configurationRef: "host-config:mcp-main",
    },
    protocolRevision: MCP_PROTOCOL_REVISION,
    requiredCapabilities: ["tools", "resources", "prompts"],
    client: {
      profileId: "helarc-client",
      info: { name: "Helarc", version: "1.0.0" },
      capabilities: {},
    },
    credentialRef: "credential:mcp-main",
    trustClassification: "host-configured",
    limits: {
      connectTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
      shutdownTimeoutMs: 1_000,
      maxDiscoveryTtlMs: 60_000,
    },
  });
  await registry.activate({
    serverId: registration.serverId,
    registrationFingerprint: registration.registrationFingerprint,
  });
  return {
    registry,
    registration,
    server,
    connection: connector.connection!,
    source: null as never,
  };
}

async function readyHarness(): Promise<Harness> {
  const harness = await activatedHarness();
  harness.source = await refresh(harness);
  return harness;
}

function refresh(harness: Pick<Harness, "registry" | "registration">) {
  return harness.registry.refreshSource({
    serverId: harness.registration.serverId,
    registrationFingerprint:
      harness.registration.registrationFingerprint,
  });
}

function lookup(harness: Harness) {
  return sourceLookup(harness.source);
}

function sourceLookup(source: Harness["source"]) {
  return {
    serverId: source.serverId,
    registrationFingerprint: source.registrationFingerprint,
    sourceEpoch: source.sourceEpoch,
  };
}

class PrimitiveConnector implements McpTransportConnector {
  connection: PrimitiveConnection | null = null;

  constructor(private readonly server: PrimitiveServer) {}

  async connect(
    request: McpTransportConnectRequest,
    _control: McpTransportOperationControl,
  ): Promise<McpTransportConnection> {
    this.connection = new PrimitiveConnection(
      {
        connectionId: "connection-1",
        registrationFingerprint: request.registrationFingerprint,
        binding: request.binding,
      },
      this.server,
    );
    return this.connection;
  }
}

class PrimitiveConnection implements McpTransportConnection {
  readonly requests: Array<{
    readonly request: McpTransportRequest;
    readonly control: McpTransportOperationControl;
  }> = [];
  readonly streamRequests: Array<{
    readonly request: McpTransportRequest;
    readonly control: McpTransportOperationControl;
  }> = [];
  readonly closed = new Promise<McpTransportClosure>(() => undefined);

  constructor(
    readonly identity: McpTransportConnectionIdentity,
    private readonly server: PrimitiveServer,
  ) {}

  async request(
    request: McpTransportRequest,
    control: McpTransportOperationControl,
  ): Promise<unknown> {
    this.requests.push({ request, control });
    return this.server.request(request, control);
  }

  async openStream(
    request: McpTransportRequest,
    control: McpTransportOperationControl,
  ): Promise<McpTransportResponseStream> {
    this.streamRequests.push({ request, control });
    return this.server.openStream(request);
  }

  async close(
    _request: McpTransportCloseRequest,
    _control: McpTransportOperationControl,
  ): Promise<void> {}
}

class PrimitiveServer {
  catalogVersion = 1;
  failPromptList = false;
  invalidToolOutput = false;
  pendingToolCall = false;
  rejectProtocolRevision = false;
  toolCallCount = 0;
  resourceReadCount = 0;
  promptGetCount = 0;
  lastSubscription: AsyncMessageQueue | null = null;

  request(
    request: McpTransportRequest,
    _control: McpTransportOperationControl,
  ): unknown | Promise<unknown> {
    const { id, method, params } = request.message;
    switch (method) {
      case "server/discover":
        return response(id, {
          resultType: "complete",
          supportedVersions: ["2026-07-28"],
          capabilities: {
            tools: { listChanged: true },
            resources: { listChanged: true, subscribe: true },
            prompts: { listChanged: true },
          },
          ttlMs: 30_000,
          cacheScope: "private",
        });
      case "tools/list":
        return this.toolList(id, params.cursor);
      case "resources/list":
        return listResponse(id, "resources", [{
          uri: "memory://docs/guide",
          name: "Guide",
          mimeType: "text/plain",
        }]);
      case "resources/templates/list":
        return listResponse(id, "resourceTemplates", [{
          uriTemplate: "memory://docs/{name}",
          name: "Document",
        }]);
      case "prompts/list":
        return this.failPromptList
          ? response(id, {
              resultType: "complete",
              prompts: "invalid",
              ttlMs: 30_000,
              cacheScope: "private",
            })
          : listResponse(id, "prompts", [{
              name: "review",
              description: "Review one topic.",
              arguments: [{ name: "topic", required: true }],
            }]);
      case "tools/call":
        this.toolCallCount += 1;
        if (this.pendingToolCall) {
          return new Promise<unknown>(() => undefined);
        }
        if (this.rejectProtocolRevision) {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32022,
              message: "Unsupported protocol version",
            },
          };
        }
        return response(id, {
          resultType: "complete",
          content: [{
            type: "text",
            text: String(
              (params.arguments as { readonly message?: unknown }).message,
            ),
          }],
          structuredContent: this.invalidToolOutput
            ? { echo: 42 }
            : {
                echo:
                  (params.arguments as { readonly message: string }).message,
              },
          isError: false,
        });
      case "resources/read":
        this.resourceReadCount += 1;
        return response(id, {
          resultType: "complete",
          contents: [{
            uri: params.uri,
            mimeType: "text/plain",
            text: "Guide content",
          }],
          ttlMs: 30_000,
          cacheScope: "private",
        });
      case "prompts/get":
        this.promptGetCount += 1;
        return response(id, {
          resultType: "complete",
          description: "Review prompt.",
          messages: [{
            role: "user",
            content: {
              type: "text",
              text: `Review ${
                (params.arguments as { readonly topic: string }).topic
              }`,
            },
          }],
        });
      default:
        throw new Error(`Unexpected MCP request method '${method}'.`);
    }
  }

  openStream(request: McpTransportRequest): McpTransportResponseStream {
    if (request.message.method !== "subscriptions/listen") {
      throw new Error("Unexpected MCP stream request.");
    }
    this.lastSubscription = new AsyncMessageQueue();
    return Object.freeze({ messages: this.lastSubscription });
  }

  private toolList(id: string, cursor: unknown): unknown {
    if (cursor === undefined) {
      return listResponse(id, "tools", [
        {
          name: "echo",
          title: `Echo v${this.catalogVersion}`,
          description: "Echo one message.",
          inputSchema: {
            type: "object",
            properties: {
              message: {
                type: "string",
                "x-mcp-header": "Message",
              },
            },
            required: ["message"],
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            properties: {
              echo: { type: "string" },
            },
            required: ["echo"],
            additionalProperties: false,
          },
        },
        {
          name: "invalidRoot",
          inputSchema: { type: "string" },
        },
      ], "opaque=next page");
    }
    return listResponse(id, "tools", [{
      name: "inspect",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    }]);
  }
}

class AsyncMessageQueue implements AsyncIterable<unknown> {
  private readonly values: unknown[] = [];
  private readonly waiters: Array<
    (value: IteratorResult<unknown>) => void
  > = [];
  private consumed = 0;

  push(value: unknown): void {
    const waiter = this.waiters.shift();
    if (waiter === undefined) {
      this.values.push(value);
      return;
    }
    this.consumed += 1;
    waiter({ done: false, value });
  }

  async waitUntilConsumed(count: number): Promise<void> {
    await vi.waitFor(() => {
      expect(this.consumed).toBeGreaterThanOrEqual(count);
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) {
          this.consumed += 1;
          return Promise.resolve({ done: false, value });
        }
        return new Promise<IteratorResult<unknown>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
      return: async () => ({ done: true, value: undefined }),
    };
  }
}

function response(id: string, result: Record<string, unknown>): unknown {
  return { jsonrpc: "2.0", id, result };
}

function listResponse(
  id: string,
  field: string,
  items: readonly unknown[],
  nextCursor?: string,
): unknown {
  return response(id, {
    resultType: "complete",
    [field]: items,
    ...(nextCursor === undefined ? {} : { nextCursor }),
    ttlMs: 30_000,
    cacheScope: "private",
  });
}

function subscriptionNotification(
  subscriptionId: string,
  method: string,
  params: Record<string, unknown>,
): unknown {
  return {
    jsonrpc: "2.0",
    method,
    params: {
      ...params,
      _meta: {
        [SUBSCRIPTION_ID_META_KEY]: subscriptionId,
      },
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

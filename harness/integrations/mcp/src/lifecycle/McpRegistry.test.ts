import { describe, expect, it, vi } from "vitest";
import {
  McpActivationError,
  type McpActivationSnapshot,
} from "./McpLifecycle.js";
import {
  createMcpServerRegistration,
  MCP_PROTOCOL_REVISION,
  type McpServerRegistrationInput,
} from "../registration/McpRegistration.js";
import { McpRegistry } from "./McpRegistry.js";
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
} from "../transport/McpTransport.js";

const NOW = "2026-08-03T04:00:00.000Z";

describe("MCP registration", () => {
  it("creates deterministic immutable registration snapshots", () => {
    const input = registrationInput();
    const first = createMcpServerRegistration(input);
    const second = createMcpServerRegistration(registrationInput());

    (input.transport as { bindingId: string }).bindingId = "changed";
    (input.requiredCapabilities as string[]).push("prompts");

    expect(first.registrationFingerprint).toBe(second.registrationFingerprint);
    expect(first.transport.bindingId).toBe("binding-main");
    expect(first.requiredCapabilities).toEqual(["resources", "tools"]);
    expect(first.registrationFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.transport.bindingFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.transport)).toBe(true);
    expect(Object.isFrozen(first.client.capabilities)).toBe(true);
  });

  it("rejects unsupported client feature advertisement and protocol revisions", () => {
    expect(() => createMcpServerRegistration(registrationInput({
      client: {
        profileId: "helarc-client",
        info: { name: "Helarc", version: "1.0.0" },
        capabilities: { roots: {} },
      },
    }))).toThrow("must not advertise unsupported client features");

    expect(() => createMcpServerRegistration({
      ...registrationInput(),
      protocolRevision: "2025-11-25",
    } as never)).toThrow(`must use protocol revision ${MCP_PROTOCOL_REVISION}`);
  });

  it("rejects accessor-backed registration arrays before reading them", () => {
    let evaluated = false;
    const requiredCapabilities: string[] = [];
    Object.defineProperty(requiredCapabilities, "0", {
      enumerable: true,
      get() {
        evaluated = true;
        return "tools";
      },
    });
    requiredCapabilities.length = 1;

    expect(() => createMcpServerRegistration(registrationInput({
      requiredCapabilities: requiredCapabilities as never,
    }))).toThrow("must be an enumerable data property");
    expect(evaluated).toBe(false);
  });
});

describe("McpRegistry activation lifecycle", () => {
  it("publishes an activation only after validated stateless discovery", async () => {
    const connector = new TestConnector();
    const { registry, registration } = setup(connector);

    const activation = await registry.activate({
      serverId: registration.serverId,
      registrationFingerprint: registration.registrationFingerprint,
    });

    const call = connector.connections[0]!.requests[0]!;
    expect(call.request).toEqual({
      message: {
        jsonrpc: "2.0",
        id: "id-2",
        method: "server/discover",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": {
              name: "Helarc",
              version: "1.0.0",
            },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      },
      httpHeaders: {
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "server/discover",
      },
    });
    expect(call.control).toMatchObject({
      operationId: "id-1:discover",
      registrationFingerprint: registration.registrationFingerprint,
      sourceEpoch: null,
    });
    expect(JSON.stringify(call.request.message)).not.toContain("sourceEpoch");
    expect(JSON.stringify(call.request.message)).not.toContain("AbortSignal");
    expect(connector.connections[0]!.requests.map(
      ({ request }) => request.message.method,
    )).toEqual(["server/discover"]);
    expect(activation).toMatchObject({
      serverId: "server-main",
      activationGeneration: 1,
      protocolRevision: "2026-07-28",
      transportConnectionId: "connection-1",
      discovery: {
        serverCapabilities: {
          advertisedCapabilityIds: ["resources", "tools"],
        },
        selfReportedServerInfo: {
          name: "Example MCP",
          version: "2.0.0",
        },
        cache: {
          ttlMs: 5_000,
          scope: "private",
        },
      },
    });
    expect(registry.getState("server-main")).toMatchObject({ status: "active" });
    expect(registry.getActiveSnapshot("server-main")).toBe(activation);
    expect(Object.isFrozen(activation)).toBe(true);
    expect(Object.isFrozen(
      activation.discovery.serverCapabilities.capabilities.tools,
    )).toBe(true);
  });

  it("does not expose capabilities while discovery is pending", async () => {
    const pending = deferred<unknown>();
    const connector = new TestConnector();
    connector.handlers.push(() => pending.promise);
    const { registry, registration } = setup(connector);

    const activation = registry.activate({
      serverId: registration.serverId,
      registrationFingerprint: registration.registrationFingerprint,
    });
    await waitForRequest(connector);

    expect(registry.getState("server-main")).toMatchObject({
      status: "discovering",
    });
    expect(registry.getActiveSnapshot("server-main")).toBeNull();

    pending.resolve(discoverResponse("id-2"));
    await expect(activation).resolves.toMatchObject({
      activationGeneration: 1,
    });
  });

  it("fails closed for unsupported revisions without an initialize fallback", async () => {
    const connector = new TestConnector();
    connector.handlers.push((request) => ({
      jsonrpc: "2.0",
      id: request.message.id,
      error: {
        code: -32022,
        message: "Unsupported protocol version",
        data: { supported: ["2025-11-25"] },
      },
    }), (request) => discoverResponse(request.message.id));
    const { registry, registration } = setup(connector);

    await expect(registry.activate({
      serverId: registration.serverId,
      registrationFingerprint: registration.registrationFingerprint,
    })).rejects.toMatchObject({
      code: "mcp_protocol_version_unsupported",
    });

    expect(connector.connections[0]!.requests.map(
      ({ request }) => request.message.method,
    )).toEqual(["server/discover"]);
    expect(registry.getState("server-main")).toMatchObject({
      status: "failed",
      failure: { code: "mcp_protocol_version_unsupported" },
    });
    expect(registry.getActiveSnapshot("server-main")).toBeNull();
    expect(connector.connections[0]!.closes).toEqual([
      { reason: "activation_failed" },
    ]);

    await expect(registry.activate({
      serverId: registration.serverId,
      registrationFingerprint: registration.registrationFingerprint,
    })).resolves.toMatchObject({
      activationGeneration: 1,
    });
  });

  it("uses body-only protocol metadata for stdio transport", async () => {
    const connector = new TestConnector();
    const { registry, registration } = setup(connector, {
      transport: {
        kind: "stdio",
        bindingId: "binding-stdio",
        bindingRevision: "binding-1",
        configurationRef: "host-config:mcp-stdio",
      },
    });

    await registry.activate({
      serverId: registration.serverId,
      registrationFingerprint: registration.registrationFingerprint,
    });

    const request = connector.connections[0]!.requests[0]!.request;
    expect(request.httpHeaders).toBeNull();
    expect(request.message.params._meta).toMatchObject({
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
    });
  });

  it("rejects discovery missing a required server capability", async () => {
    const connector = new TestConnector();
    connector.handlers.push((request) => discoverResponse(
      request.message.id,
      { tools: {} },
    ));
    const { registry, registration } = setup(connector);

    await expect(registry.activate({
      serverId: registration.serverId,
      registrationFingerprint: registration.registrationFingerprint,
    })).rejects.toMatchObject({
      code: "mcp_required_capability_missing",
    });
    expect(registry.getActiveSnapshot("server-main")).toBeNull();
  });

  it("rejects accessor-backed protocol arrays before reading them", async () => {
    let evaluated = false;
    const supportedVersions: string[] = [];
    Object.defineProperty(supportedVersions, "0", {
      enumerable: true,
      get() {
        evaluated = true;
        return MCP_PROTOCOL_REVISION;
      },
    });
    supportedVersions.length = 1;
    const connector = new TestConnector();
    connector.handlers.push((request) => ({
      jsonrpc: "2.0",
      id: request.message.id,
      result: {
        resultType: "complete",
        supportedVersions,
        capabilities: { tools: {}, resources: {} },
        ttlMs: 10_000,
        cacheScope: "private",
      },
    }));
    const { registry, registration } = setup(connector);

    await expect(registry.activate({
      serverId: registration.serverId,
      registrationFingerprint: registration.registrationFingerprint,
    })).rejects.toMatchObject({
      code: "mcp_protocol_response_invalid",
    });
    expect(evaluated).toBe(false);
    expect(registry.getActiveSnapshot("server-main")).toBeNull();
  });

  it("requires current discovery fields and ignores inert extension fields", async () => {
    const missingRequiredConnector = new TestConnector();
    missingRequiredConnector.handlers.push((request) => ({
      jsonrpc: "2.0",
      id: request.message.id,
      result: {
        resultType: "complete",
        supportedVersions: [MCP_PROTOCOL_REVISION],
        capabilities: { tools: {}, resources: {} },
        cacheScope: "private",
      },
    }));
    const missingRequired = setup(missingRequiredConnector);

    await expect(missingRequired.registry.activate({
      serverId: missingRequired.registration.serverId,
      registrationFingerprint:
        missingRequired.registration.registrationFingerprint,
    })).rejects.toMatchObject({
      code: "mcp_protocol_response_invalid",
    });

    const extensionConnector = new TestConnector();
    extensionConnector.handlers.push((request) => {
      const response = discoverResponse(request.message.id) as {
        readonly jsonrpc: "2.0";
        readonly id: string;
        readonly result: Record<string, unknown>;
      };
      return {
        ...response,
        result: {
          ...response.result,
          "com.example/discoveryExtension": {
            informational: true,
          },
        },
      };
    });
    const extension = setup(extensionConnector);

    await expect(extension.registry.activate({
      serverId: extension.registration.serverId,
      registrationFingerprint: extension.registration.registrationFingerprint,
    })).resolves.toMatchObject({
      activationGeneration: 1,
    });
    expect(
      extension.registry.getActiveSnapshot("server-main")?.discovery,
    ).not.toHaveProperty("com.example/discoveryExtension");
  });

  it("cancels discovery locally and never fabricates a response", async () => {
    const pending = deferred<unknown>();
    const connector = new TestConnector();
    connector.handlers.push(() => pending.promise);
    const { registry, registration } = setup(connector);
    const controller = new AbortController();

    const activation = registry.activate({
      serverId: registration.serverId,
      registrationFingerprint: registration.registrationFingerprint,
      signal: controller.signal,
    });
    await waitForRequest(connector);
    const transportSignal =
      connector.connections[0]!.requests[0]!.control.signal;
    controller.abort();

    await expect(activation).rejects.toMatchObject({
      code: "mcp_activation_cancelled",
    });
    expect(transportSignal.aborted).toBe(true);
    expect(registry.getState("server-main")).toMatchObject({
      status: "failed",
      failure: { code: "mcp_activation_cancelled" },
    });
    expect(registry.getActiveSnapshot("server-main")).toBeNull();
  });

  it("enforces the discovery deadline", async () => {
    vi.useFakeTimers();
    try {
      const connector = new TestConnector();
      connector.handlers.push(() => new Promise(() => undefined));
      const { registry, registration } = setup(connector, {
        limits: {
          connectTimeoutMs: 1_000,
          requestTimeoutMs: 10,
          shutdownTimeoutMs: 1_000,
          maxDiscoveryTtlMs: 5_000,
        },
      });

      const activation = registry.activate({
        serverId: registration.serverId,
        registrationFingerprint: registration.registrationFingerprint,
      });
      const rejection = expect(activation).rejects.toMatchObject({
        code: "mcp_discovery_timeout",
      });
      await vi.advanceTimersByTimeAsync(11);

      await rejection;
      expect(registry.getState("server-main")).toMatchObject({
        status: "failed",
        failure: { code: "mcp_discovery_timeout" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("enforces the transport connection deadline", async () => {
    vi.useFakeTimers();
    try {
      const connector: McpTransportConnector = {
        connect: () => new Promise(() => undefined),
      };
      const { registry, registration } = setup(connector, {
        limits: {
          connectTimeoutMs: 10,
          requestTimeoutMs: 1_000,
          shutdownTimeoutMs: 1_000,
          maxDiscoveryTtlMs: 5_000,
        },
      });

      const activation = registry.activate({
        serverId: registration.serverId,
        registrationFingerprint: registration.registrationFingerprint,
      });
      const rejection = expect(activation).rejects.toMatchObject({
        code: "mcp_transport_connect_timeout",
      });
      await vi.advanceTimersByTimeAsync(11);

      await rejection;
      expect(registry.getState("server-main")).toMatchObject({
        status: "failed",
        failure: { code: "mcp_transport_connect_timeout" },
      });
      expect(registry.getActiveSnapshot("server-main")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("deactivates explicitly and closes the exact active connection", async () => {
    const connector = new TestConnector();
    const { registry, registration } = setup(connector);
    await registry.activate({
      serverId: registration.serverId,
      registrationFingerprint: registration.registrationFingerprint,
    });

    await registry.deactivate({
      serverId: registration.serverId,
      registrationFingerprint: registration.registrationFingerprint,
    });

    expect(connector.connections[0]!.closes).toEqual([
      { reason: "deactivated" },
    ]);
    expect(registry.getState("server-main")).toMatchObject({
      status: "stopped",
      reason: "deactivated",
    });
    expect(registry.getActiveSnapshot("server-main")).toBeNull();
  });

  it("fails deactivation when transport shutdown exceeds its deadline", async () => {
    vi.useFakeTimers();
    try {
      const connector = new TestConnector();
      const { registry, registration } = setup(connector, {
        limits: {
          connectTimeoutMs: 1_000,
          requestTimeoutMs: 1_000,
          shutdownTimeoutMs: 10,
          maxDiscoveryTtlMs: 5_000,
        },
      });
      await registry.activate({
        serverId: registration.serverId,
        registrationFingerprint: registration.registrationFingerprint,
      });
      connector.connections[0]!.closeHandler =
        () => new Promise(() => undefined);

      const deactivation = registry.deactivate({
        serverId: registration.serverId,
        registrationFingerprint: registration.registrationFingerprint,
      });
      const rejection = expect(deactivation).rejects.toMatchObject({
        code: "mcp_transport_shutdown_timeout",
      });
      await vi.advanceTimersByTimeAsync(11);

      await rejection;
      expect(registry.getState("server-main")).toMatchObject({
        status: "failed",
        failure: { code: "mcp_transport_shutdown_timeout" },
      });
      expect(registry.getActiveSnapshot("server-main")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails on transport closure and reconnects with a new epoch", async () => {
    const connector = new TestConnector();
    const { registry, registration } = setup(connector);
    const first = await registry.activate({
      serverId: registration.serverId,
      registrationFingerprint: registration.registrationFingerprint,
    });

    connector.connections[0]!.terminate({
      kind: "failed",
      code: "connection_lost",
      message: "connection lost",
    });
    await flushMicrotasks();
    expect(registry.getState("server-main")).toMatchObject({
      status: "failed",
      failure: { code: "mcp_transport_failed" },
    });

    const second = await registry.activate({
      serverId: registration.serverId,
      registrationFingerprint: registration.registrationFingerprint,
    });

    expect(first.activationGeneration).toBe(1);
    expect(second.activationGeneration).toBe(2);
    expect(second.transportConnectionId).toBe("connection-2");
    expect(registry.getActiveSnapshot("server-main")).toBe(second);
  });

  it("rejects stale activation results during stop and reconnect races", async () => {
    const staleResponse = deferred<unknown>();
    const connector = new TestConnector();
    connector.handlers.push(
      () => staleResponse.promise,
      (request) => discoverResponse(request.message.id),
    );
    const { registry, registration } = setup(connector);
    const firstAttempt = registry.activate({
      serverId: registration.serverId,
      registrationFingerprint: registration.registrationFingerprint,
    });
    await waitForRequest(connector);

    await registry.deactivate({
      serverId: registration.serverId,
      registrationFingerprint: registration.registrationFingerprint,
    });
    await expect(firstAttempt).rejects.toMatchObject({
      code: "mcp_activation_stale",
    });
    const current = await registry.activate({
      serverId: registration.serverId,
      registrationFingerprint: registration.registrationFingerprint,
    });

    staleResponse.resolve(discoverResponse("id-2", { prompts: {} }));
    await flushMicrotasks();

    expect(current.activationGeneration).toBe(1);
    expect(current.discovery.serverCapabilities.advertisedCapabilityIds).toEqual([
      "resources",
      "tools",
    ]);
    expect(registry.getActiveSnapshot("server-main")).toBe(current);
    expect(connector.connections[0]!.closes).toEqual([
      { reason: "deactivated" },
    ]);
  });

  it("uses compare-and-swap registration replacement and rejects stale callers", async () => {
    const connector = new TestConnector();
    const { registry, registration } = setup(connector);
    const replacement = registry.replaceRegistration({
      expectedRegistrationFingerprint: registration.registrationFingerprint,
      registration: registrationInput({
        registrationRevision: "revision-2",
        transport: {
          kind: "streamable-http",
          bindingId: "binding-main",
          bindingRevision: "binding-2",
          configurationRef: "host-config:mcp-main",
        },
      }),
    });

    expect(replacement.registrationFingerprint).not.toBe(
      registration.registrationFingerprint,
    );
    await expect(registry.activate({
      serverId: registration.serverId,
      registrationFingerprint: registration.registrationFingerprint,
    })).rejects.toBeInstanceOf(McpActivationError);
    expect(registry.getState("server-main")).toMatchObject({
      status: "registered",
      registrationFingerprint: replacement.registrationFingerprint,
    });
  });

  it("rejects a transport connection attributed to another registration", async () => {
    const connector = new TestConnector();
    connector.identityOverride = (identity) => ({
      ...identity,
      registrationFingerprint: `sha256:${"f".repeat(64)}`,
    });
    const { registry, registration } = setup(connector);

    await expect(registry.activate({
      serverId: registration.serverId,
      registrationFingerprint: registration.registrationFingerprint,
    })).rejects.toMatchObject({
      code: "mcp_transport_identity_mismatch",
    });
    expect(registry.getActiveSnapshot("server-main")).toBeNull();
  });
});

class TestConnector implements McpTransportConnector {
  readonly connections: TestConnection[] = [];
  readonly handlers: RequestHandler[] = [];
  identityOverride?: (
    identity: McpTransportConnectionIdentity,
  ) => McpTransportConnectionIdentity;

  async connect(
    request: McpTransportConnectRequest,
    _control: McpTransportOperationControl,
  ): Promise<McpTransportConnection> {
    const identity = {
      connectionId: `connection-${this.connections.length + 1}`,
      registrationFingerprint: request.registrationFingerprint,
      binding: request.binding,
    };
    const connection = new TestConnection(
      this.identityOverride?.(identity) ?? identity,
      this.handlers.shift() ?? ((message) =>
        discoverResponse(message.message.id)),
    );
    this.connections.push(connection);
    return connection;
  }
}

type RequestHandler = (
  request: McpTransportRequest,
  control: McpTransportOperationControl,
) => unknown | Promise<unknown>;

class TestConnection implements McpTransportConnection {
  readonly requests: Array<{
    readonly request: McpTransportRequest;
    readonly control: McpTransportOperationControl;
  }> = [];
  readonly closes: McpTransportCloseRequest[] = [];
  closeHandler?: (
    request: McpTransportCloseRequest,
    control: McpTransportOperationControl,
  ) => Promise<void>;
  private readonly closure = deferred<McpTransportClosure>();
  readonly closed = this.closure.promise;

  constructor(
    readonly identity: McpTransportConnectionIdentity,
    private readonly handler: RequestHandler,
  ) {}

  async request(
    request: McpTransportRequest,
    control: McpTransportOperationControl,
  ): Promise<unknown> {
    this.requests.push({ request, control });
    return this.handler(request, control);
  }

  async openStream(
    _request: McpTransportRequest,
    _control: McpTransportOperationControl,
  ): Promise<McpTransportResponseStream> {
    throw new Error("Test connection has no configured response stream.");
  }

  async close(
    request: McpTransportCloseRequest,
    control: McpTransportOperationControl,
  ): Promise<void> {
    this.closes.push(request);
    await this.closeHandler?.(request, control);
  }

  terminate(closure: McpTransportClosure): void {
    this.closure.resolve(closure);
  }
}

function setup(
  connector: McpTransportConnector,
  overrides: Partial<McpServerRegistrationInput> = {},
) {
  let sequence = 0;
  const registry = new McpRegistry({
    connector,
    now: () => new Date(NOW),
    createId: () => `id-${++sequence}`,
  });
  const registration = registry.register(registrationInput(overrides));
  return { registry, registration };
}

function registrationInput(
  overrides: Partial<McpServerRegistrationInput> = {},
): McpServerRegistrationInput {
  return {
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
    requiredCapabilities: ["tools", "resources"],
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
      maxDiscoveryTtlMs: 5_000,
    },
    ...overrides,
  };
}

function discoverResponse(
  requestId: string,
  capabilities: Record<string, unknown> = {
    tools: { listChanged: true },
    resources: { subscribe: true },
  },
): unknown {
  return {
    jsonrpc: "2.0",
    id: requestId,
    result: {
      resultType: "complete",
      supportedVersions: ["2026-07-28"],
      capabilities,
      _meta: {
        "io.modelcontextprotocol/serverInfo": {
          name: "Example MCP",
          version: "2.0.0",
        },
      },
      instructions: "Use the advertised primitives deliberately.",
      ttlMs: 10_000,
      cacheScope: "private",
    },
  };
}

async function waitForRequest(connector: TestConnector): Promise<void> {
  await vi.waitFor(() => {
    expect(connector.connections[0]?.requests).toHaveLength(1);
  });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

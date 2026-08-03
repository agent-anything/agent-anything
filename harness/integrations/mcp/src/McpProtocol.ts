import type { ISODateTimeString } from "@agent-anything/foundation";
import {
  assertCanonicalDataArray,
  assertExactDataProperties,
  assertExtensibleDataProperties,
  assertPlainRecord,
  createMcpContractFingerprint,
  isMcpJsonObject,
  type McpJsonObject,
  snapshotMcpJsonObject,
  validateMcpText,
  validateMcpToken,
  validateNonNegativeSafeInteger,
} from "./McpJson.js";
import {
  MCP_PROTOCOL_REVISION,
  type McpClientProfile,
  type McpProtocolRevision,
  type McpServerCapabilityId,
  type McpTransportKind,
} from "./McpRegistration.js";
import type { McpTransportRequest } from "./McpTransport.js";

const PROTOCOL_VERSION_META_KEY =
  "io.modelcontextprotocol/protocolVersion";
const CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";
const CLIENT_CAPABILITIES_META_KEY =
  "io.modelcontextprotocol/clientCapabilities";
const SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";

export type McpCacheScope = "public" | "private";

export interface McpServerCapabilitySnapshot {
  readonly schemaVersion: 1;
  readonly snapshotId: string;
  readonly advertisedCapabilityIds: readonly string[];
  readonly capabilities: McpJsonObject;
}

export interface McpDiscoverySnapshot {
  readonly protocolRevision: McpProtocolRevision;
  readonly serverCapabilities: McpServerCapabilitySnapshot;
  readonly selfReportedServerInfo: {
    readonly name: string;
    readonly version: string;
  } | null;
  readonly instructions: string | null;
  readonly cache: {
    readonly ttlMs: number;
    readonly scope: McpCacheScope;
    readonly receivedAt: ISODateTimeString;
    readonly expiresAt: ISODateTimeString;
  };
}

export type McpProtocolErrorCode =
  | "mcp_protocol_response_invalid"
  | "mcp_discovery_rejected"
  | "mcp_protocol_version_unsupported"
  | "mcp_required_capability_missing";

export class McpProtocolError extends Error {
  constructor(
    readonly code: McpProtocolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "McpProtocolError";
  }
}

export function createMcpDiscoverRequest(input: {
  readonly requestId: string;
  readonly transportKind: McpTransportKind;
  readonly client: McpClientProfile;
}): McpTransportRequest {
  const requestId = validateMcpToken(
    input.requestId,
    "discover.requestId",
    512,
  );
  const clientInfo: McpJsonObject = Object.freeze({
    name: input.client.info.name,
    version: input.client.info.version,
  });
  const meta: McpJsonObject = Object.freeze({
    [PROTOCOL_VERSION_META_KEY]: MCP_PROTOCOL_REVISION,
    [CLIENT_INFO_META_KEY]: clientInfo,
    [CLIENT_CAPABILITIES_META_KEY]: input.client.capabilities,
  });
  const params: McpJsonObject = Object.freeze({
    _meta: meta,
  });
  const message = Object.freeze({
    jsonrpc: "2.0" as const,
    id: requestId,
    method: "server/discover",
    params,
  });
  return Object.freeze({
    message,
    httpHeaders: input.transportKind === "streamable-http"
      ? Object.freeze({
        Accept: "application/json, text/event-stream" as const,
        "MCP-Protocol-Version": MCP_PROTOCOL_REVISION,
        "Mcp-Method": "server/discover",
      })
      : null,
  });
}

export function parseMcpDiscoverResponse(input: {
  readonly response: unknown;
  readonly requestId: string;
  readonly requiredCapabilities: readonly McpServerCapabilityId[];
  readonly maxTtlMs: number;
  readonly receivedAt: ISODateTimeString;
}): McpDiscoverySnapshot {
  try {
    assertPlainRecord(input.response, "response");
    assertExactDataProperties(
      input.response,
      new Set(["jsonrpc", "id"]),
      new Set(["result", "error"]),
      "response",
    );
    if (input.response.jsonrpc !== "2.0" || input.response.id !== input.requestId) {
      invalid("MCP discovery response identity is invalid.");
    }
    const hasResult = Object.hasOwn(input.response, "result");
    const hasError = Object.hasOwn(input.response, "error");
    if (hasResult === hasError) {
      invalid("MCP discovery response must contain exactly one result or error.");
    }
    if (hasError) {
      throwDiscoveryError(input.response.error);
    }

    assertPlainRecord(input.response.result, "response.result");
    assertExtensibleDataProperties(
      input.response.result,
      new Set([
        "resultType",
        "supportedVersions",
        "capabilities",
        "ttlMs",
        "cacheScope",
      ]),
      "response.result",
    );
    if (input.response.result.resultType !== "complete") {
      invalid("MCP discovery must settle with resultType 'complete'.");
    }
    const supportedVersions = snapshotSupportedVersions(
      input.response.result.supportedVersions,
    );
    if (!supportedVersions.includes(MCP_PROTOCOL_REVISION)) {
      throw new McpProtocolError(
        "mcp_protocol_version_unsupported",
        `MCP server does not support required revision ${MCP_PROTOCOL_REVISION}.`,
      );
    }
    const capabilities = snapshotMcpJsonObject(
      input.response.result.capabilities,
      "response.result.capabilities",
    );
    validateCapabilityShape(capabilities);
    for (const capability of input.requiredCapabilities) {
      if (!Object.hasOwn(capabilities, capability)) {
        throw new McpProtocolError(
          "mcp_required_capability_missing",
          `MCP server is missing required capability '${capability}'.`,
        );
      }
    }
    const advertisedCapabilityIds = Object.freeze(
      Object.keys(capabilities).sort(),
    );
    const serverCapabilities = Object.freeze({
      schemaVersion: 1 as const,
      snapshotId: createMcpContractFingerprint(
        "agent-anything.mcp-server-capabilities.v1",
        capabilities,
      ),
      advertisedCapabilityIds,
      capabilities,
    });
    const selfReportedServerInfo = snapshotServerInfo(
      input.response.result._meta,
    );
    const instructions = input.response.result.instructions === undefined
      ? null
      : validateMcpText(
        input.response.result.instructions,
        "response.result.instructions",
        32_768,
      );
    const advertisedTtlMs = validateNonNegativeSafeInteger(
      input.response.result.ttlMs,
      "response.result.ttlMs",
    );
    const ttlMs = Math.min(advertisedTtlMs, input.maxTtlMs);
    const scope = snapshotCacheScope(input.response.result.cacheScope);
    const receivedAtMs = Date.parse(input.receivedAt);
    if (!Number.isFinite(receivedAtMs)) {
      invalid("MCP discovery receivedAt is invalid.");
    }
    const expiresAtMs = receivedAtMs + ttlMs;
    if (!Number.isSafeInteger(expiresAtMs)) {
      invalid("MCP discovery cache expiry exceeds the supported range.");
    }

    return Object.freeze({
      protocolRevision: MCP_PROTOCOL_REVISION,
      serverCapabilities,
      selfReportedServerInfo,
      instructions,
      cache: Object.freeze({
        ttlMs,
        scope,
        receivedAt: input.receivedAt,
        expiresAt: new Date(expiresAtMs).toISOString(),
      }),
    });
  } catch (error) {
    if (error instanceof McpProtocolError) throw error;
    throw new McpProtocolError(
      "mcp_protocol_response_invalid",
      error instanceof Error
        ? error.message
        : "MCP discovery response is invalid.",
    );
  }
}

function snapshotSupportedVersions(input: unknown): readonly string[] {
  assertCanonicalDataArray(input, "response.result.supportedVersions");
  if (input.length === 0 || input.length > 64) {
    invalid("MCP supportedVersions must be a bounded non-empty array.");
  }
  const versions = new Set<string>();
  for (let index = 0; index < input.length; index += 1) {
    if (!Object.hasOwn(input, index)) {
      invalid("MCP supportedVersions cannot be sparse.");
    }
    const version = validateMcpToken(
      input[index],
      `response.result.supportedVersions[${index}]`,
      128,
    );
    if (versions.has(version)) {
      invalid(`MCP supported protocol revision '${version}' is duplicated.`);
    }
    versions.add(version);
  }
  return Object.freeze([...versions]);
}

function validateCapabilityShape(capabilities: McpJsonObject): void {
  for (const [capabilityId, capability] of Object.entries(capabilities)) {
    validateMcpToken(
      capabilityId,
      `response.result.capabilities.${capabilityId}`,
      256,
    );
    if (
      capability === null ||
      typeof capability !== "object" ||
      Array.isArray(capability)
    ) {
      invalid(`MCP capability '${capabilityId}' must be an object.`);
    }
  }
}

function snapshotServerInfo(input: unknown): {
  readonly name: string;
  readonly version: string;
} | null {
  if (input === undefined) return null;
  const meta = snapshotMcpJsonObject(input, "response.result._meta");
  const serverInfo = meta[SERVER_INFO_META_KEY];
  if (serverInfo === undefined) return null;
  if (!isMcpJsonObject(serverInfo)) {
    invalid("MCP self-reported serverInfo must be an object.");
  }
  const name = validateMcpText(
    serverInfo.name,
    `response.result._meta.${SERVER_INFO_META_KEY}.name`,
    256,
  );
  const version = validateMcpToken(
    serverInfo.version,
    `response.result._meta.${SERVER_INFO_META_KEY}.version`,
    256,
  );
  return Object.freeze({ name, version });
}

function snapshotCacheScope(input: unknown): McpCacheScope {
  if (input !== "public" && input !== "private") {
    invalid("MCP discovery cacheScope must be public or private.");
  }
  return input;
}

function throwDiscoveryError(input: unknown): never {
  assertPlainRecord(input, "response.error");
  assertExactDataProperties(
    input,
    new Set(["code", "message"]),
    new Set(["data"]),
    "response.error",
  );
  if (!Number.isSafeInteger(input.code) || typeof input.message !== "string") {
    invalid("MCP discovery error response is malformed.");
  }
  if (input.code === -32022) {
    throw new McpProtocolError(
      "mcp_protocol_version_unsupported",
      `MCP server rejected revision ${MCP_PROTOCOL_REVISION}.`,
    );
  }
  throw new McpProtocolError(
    "mcp_discovery_rejected",
    "MCP server rejected discovery.",
  );
}

function invalid(message: string): never {
  throw new McpProtocolError("mcp_protocol_response_invalid", message);
}

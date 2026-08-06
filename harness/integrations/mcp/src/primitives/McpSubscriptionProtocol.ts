import {
  type McpJsonObject,
  snapshotMcpJsonObject,
} from "../protocol/McpJson.js";
import { parseMcpOperationResponse } from "../protocol/McpProtocol.js";
import type {
  McpSourceSnapshot,
  McpSubscriptionEvent,
  McpSubscriptionFilter,
} from "./McpPrimitives.js";
import { McpPrimitiveError } from "./McpPrimitiveError.js";
import { validateMcpResourceUri } from "./McpResourceCache.js";

const SUBSCRIPTION_ID_META_KEY =
  "io.modelcontextprotocol/subscriptionId";

export function validateMcpSubscriptionFilter(
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
      mcpSubscriptionInvalid(
        "MCP resource subscription filter must be bounded and non-empty.",
      );
    }
    const values = new Set(
      input.resourceSubscriptions.map(validateMcpResourceUri),
    );
    accepted.resourceSubscriptions = Object.freeze([...values].sort());
  }
  if (Object.keys(accepted).length === 0) {
    mcpSubscriptionInvalid("MCP subscription filter cannot be empty.");
  }
  return Object.freeze(accepted);
}

export function validateMcpAcknowledgedFilter(
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
    mcpSubscriptionInvalid(
      "MCP subscription acknowledgement exceeds the requested filter.",
    );
  }
  const requestedUris = new Set(requested.resourceSubscriptions ?? []);
  if (
    candidate.resourceSubscriptions?.some(
      (uri) => !requestedUris.has(uri),
    )
  ) {
    mcpSubscriptionInvalid(
      "MCP subscription acknowledgement contains an unrequested Resource URI.",
    );
  }
  return candidate;
}

export function mcpSubscriptionFilterToJson(
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

export function parseMcpSubscriptionNotification(
  input: unknown,
  subscriptionId: string,
): {
  readonly method: string;
  readonly params: McpJsonObject;
} {
  const message = snapshotMcpJsonObject(input, "subscription.message");
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    mcpSubscriptionInvalid("MCP subscription notification is invalid.");
  }
  const params: McpJsonObject = message.params === undefined
    ? Object.freeze({})
    : snapshotMcpJsonObject(message.params, "subscription.message.params");
  const meta = snapshotMcpJsonObject(
    params._meta,
    "subscription.message.params._meta",
  );
  if (meta[SUBSCRIPTION_ID_META_KEY] !== subscriptionId) {
    mcpSubscriptionInvalid("MCP subscription notification is uncorrelated.");
  }
  return Object.freeze({ method: message.method, params });
}

export function validateMcpSubscribedEvent(
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
      const uri = validateMcpResourceUri(input.params.uri);
      if (!accepted.resourceSubscriptions.includes(uri)) break;
      return Object.freeze({ kind: "resource-updated", uri });
    }
  }
  return mcpSubscriptionInvalid(
    "MCP subscription delivered an unrequested notification.",
  );
}

export function parseMcpSubscriptionCompletion(
  input: unknown,
  subscriptionId: string,
): void {
  const result = parseMcpOperationResponse({
    response: input,
    requestId: subscriptionId,
    operation: "subscriptions/listen",
  });
  if (Object.keys(result).some((key) => key !== "_meta")) {
    mcpSubscriptionInvalid("MCP subscription completion result is invalid.");
  }
  const meta = snapshotMcpJsonObject(
    result._meta,
    "subscription.completion._meta",
  );
  if (meta[SUBSCRIPTION_ID_META_KEY] !== subscriptionId) {
    mcpSubscriptionInvalid("MCP subscription completion is uncorrelated.");
  }
}

export function isMcpJsonRpcResponse(input: unknown): boolean {
  return input !== null &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    Object.hasOwn(input, "id");
}

export function mcpSubscriptionInvalid(message: string): never {
  throw new McpPrimitiveError("mcp_subscription_invalid", message);
}

export function mcpSubscriptionInterruption(signal: AbortSignal): Error {
  return signal.reason instanceof McpPrimitiveError
    ? signal.reason
    : new McpPrimitiveError(
      "mcp_operation_cancelled",
      "MCP subscription was cancelled before acknowledgement.",
    );
}

export async function nextMcpSubscriptionMessage(
  iterator: AsyncIterator<unknown>,
  signal: AbortSignal,
): Promise<IteratorResult<unknown>> {
  if (signal.aborted) throw mcpSubscriptionInterruption(signal);
  return new Promise<IteratorResult<unknown>>((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () =>
      settle(() => reject(mcpSubscriptionInterruption(signal)));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(iterator.next()).then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error)),
    );
  });
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
      mcpSubscriptionInvalid(
        "MCP subscription filter contains an unknown field.",
      );
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
        mcpSubscriptionInvalid(
          "MCP acknowledged filter boolean values must be true.",
        );
      }
      output[field] = true;
    }
  }
  if (value.resourceSubscriptions !== undefined) {
    if (!Array.isArray(value.resourceSubscriptions)) {
      mcpSubscriptionInvalid("MCP acknowledged Resource filter is invalid.");
    }
    output.resourceSubscriptions = Object.freeze(
      value.resourceSubscriptions.map(validateMcpResourceUri).sort(),
    );
  }
  return Object.freeze(output);
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
    mcpSubscriptionInvalid(
      `MCP server did not advertise support for '${filterName}'.`,
    );
  }
}

import { createMcpContractFingerprint } from "../protocol/McpJson.js";
import type { McpParsedListPage } from "../protocol/McpPrimitiveProtocol.js";
import type {
  McpPrimitiveCache,
  McpPrimitiveDiagnostic,
  McpPrimitiveInventory,
  McpSourceSnapshot,
} from "./McpPrimitives.js";
import type {
  McpPrimitiveCoordinatorDependencies,
  McpPrimitiveTransportLease,
} from "./McpPrimitiveTransport.js";
import { McpPrimitiveError } from "./McpPrimitiveError.js";

const MAX_LIST_PAGES = 64;
const MAX_INVENTORY_ITEMS = 4_096;

export class McpPrimitiveInventoryLoader {
  constructor(
    private readonly dependencies: Pick<
      McpPrimitiveCoordinatorDependencies,
      "request"
    > & {
      nextId(subject: string): string;
      nowIso(): string;
    },
  ) {}

  async load<T, D>(input: {
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
      const requestId = this.dependencies.nextId(`${input.method} request`);
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
      const page = input.parser(
        response,
        requestId,
        this.dependencies.nowIso(),
      );
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
}

export function unsupportedInventory<T>(
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

export function replaceInventoryItems<T, U>(
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

export function requireFreshInventory(
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

export function sourceSnapshotFresh(
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

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

import type {
  HostActiveRun,
  HostRunStatusProjection,
} from "../run/HostRunManager.js";

export const HOST_QUERY_VERSION = 1 as const;

export interface HostRunStatusQuery {
  readonly version: typeof HOST_QUERY_VERSION;
  readonly queryId: string;
  readonly runId: string;
  readonly kind: "run.status";
  readonly payload: Readonly<Record<never, never>>;
}

export type HostRunStatusQueryReceipt =
  | {
      readonly version: typeof HOST_QUERY_VERSION;
      readonly queryId: string;
      readonly runId: string;
      readonly kind: "run.status";
      readonly status: "handled";
      readonly projection: HostRunStatusProjection;
    }
  | {
      readonly version: typeof HOST_QUERY_VERSION;
      readonly queryId: string;
      readonly runId: string;
      readonly kind: "run.status" | null;
      readonly status: "rejected";
      readonly code: "host_query_invalid" | "host_query_version_unsupported" | "host_query_run_not_found" | "host_query_failed";
      readonly projection: null;
    };

export interface HostRunStatusQueryHandler {
  query(candidate: unknown): HostRunStatusQueryReceipt;
}

export function createHostRunStatusQueryHandler(input: {
  readonly resolveRun: (runId: string) => HostActiveRun | null;
}): HostRunStatusQueryHandler {
  if (typeof input.resolveRun !== "function") {
    throw new TypeError("Host Run status query handler requires a Run resolver.");
  }
  return Object.freeze({
    query(candidate: unknown): HostRunStatusQueryReceipt {
      let query: HostRunStatusQuery;
      try {
        query = snapshotHostRunStatusQuery(candidate);
      } catch (error) {
        return rejected(candidate, error instanceof UnsupportedVersionError
          ? "host_query_version_unsupported"
          : "host_query_invalid");
      }
      try {
        const run = input.resolveRun(query.runId);
        if (run === null || run.runId !== query.runId) {
          return rejected(query, "host_query_run_not_found");
        }
        return Object.freeze({
          version: HOST_QUERY_VERSION,
          queryId: query.queryId,
          runId: query.runId,
          kind: "run.status" as const,
          status: "handled" as const,
          projection: run.getStatus(),
        });
      } catch {
        return rejected(query, "host_query_failed");
      }
    },
  });
}

export function snapshotHostRunStatusQuery(candidate: unknown): HostRunStatusQuery {
  const record = exactRecord(candidate, ["version", "queryId", "runId", "kind", "payload"]);
  if (record.version !== HOST_QUERY_VERSION) throw new UnsupportedVersionError();
  if (record.kind !== "run.status") throw new TypeError("Host query kind is unsupported.");
  exactRecord(record.payload, []);
  return Object.freeze({
    version: HOST_QUERY_VERSION,
    queryId: identity(record.queryId, "queryId"),
    runId: identity(record.runId, "runId"),
    kind: "run.status",
    payload: Object.freeze({}) as Readonly<Record<never, never>>,
  });
}

function rejected(
  candidate: unknown,
  code: Extract<HostRunStatusQueryReceipt, { status: "rejected" }>["code"],
): HostRunStatusQueryReceipt {
  const record = candidate !== null && typeof candidate === "object"
    ? candidate as Record<string, unknown>
    : {};
  return Object.freeze({
    version: HOST_QUERY_VERSION,
    queryId: typeof record.queryId === "string" ? record.queryId : "",
    runId: typeof record.runId === "string" ? record.runId : "",
    kind: record.kind === "run.status" ? "run.status" as const : null,
    status: "rejected" as const,
    code,
    projection: null,
  });
}

function exactRecord(input: unknown, fields: readonly string[]): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new TypeError("Host query value must be a plain object.");
  }
  const keys = Reflect.ownKeys(input);
  if (keys.length !== fields.length || keys.some((key) => typeof key !== "string" || !fields.includes(key))) {
    throw new TypeError("Host query value contains unsupported fields.");
  }
  return input as Record<string, unknown>;
}

function identity(input: unknown, field: string): string {
  if (typeof input !== "string" || input.length === 0 || /\s/.test(input)) {
    throw new TypeError(`Host query ${field} must be an identity.`);
  }
  return input;
}

class UnsupportedVersionError extends TypeError {}

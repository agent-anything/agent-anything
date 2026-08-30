import { describe, expect, it, vi } from "vitest";
import type { HostActiveRun } from "../run/HostRunManager.js";
import { createHostRunProjection } from "../projection/HostRunProjection.js";
import {
  createHostRunStatusQueryHandler,
  HOST_QUERY_VERSION,
  snapshotHostRunStatusQuery,
} from "./HostRunStatusQuery.js";
import { createTestRootRunTreeSnapshot } from "../testing/RunTreeTestSnapshot.js";

describe("Host Run status query transport", () => {
  it("snapshots the exact read-only query shape", () => {
    const payload = {};
    const query = snapshotHostRunStatusQuery({
      version: HOST_QUERY_VERSION,
      queryId: "query-1",
      runId: "run-1",
      kind: "run.status",
      payload,
    });

    expect(query).toEqual({
      version: HOST_QUERY_VERSION,
      queryId: "query-1",
      runId: "run-1",
      kind: "run.status",
      payload: {},
    });
    expect(query.payload).not.toBe(payload);
    expect(Object.isFrozen(query)).toBe(true);
    expect(Object.isFrozen(query.payload)).toBe(true);
    expect(() => snapshotHostRunStatusQuery({ ...query, legacy: true }))
      .toThrow("unsupported fields");
  });

  it("queries current Run status without command-ledger semantics", () => {
    const projection = createHostRunProjection({
      sessionId: "session-1",
      taskId: "task-1",
      runId: "run-1",
      startedAt: NOW,
      enforcement: "disabled",
      runTree: createTestRootRunTreeSnapshot("run-1", NOW),
    });
    const getStatus = vi.fn(() => projection);
    const active = { runId: "run-1", getStatus } as unknown as HostActiveRun;
    const handler = createHostRunStatusQueryHandler({
      resolveRun: (runId) => runId === active.runId ? active : null,
    });
    const query = {
      version: HOST_QUERY_VERSION,
      queryId: "query-1",
      runId: "run-1",
      kind: "run.status",
      payload: {},
    };

    expect(handler.query(query)).toMatchObject({
      status: "handled",
      projection,
    });
    expect(handler.query(query)).toMatchObject({
      status: "handled",
      projection,
    });
    expect(getStatus).toHaveBeenCalledTimes(2);
    expect(handler.query({ ...query, runId: "run-missing" })).toMatchObject({
      status: "rejected",
      code: "host_query_run_not_found",
      projection: null,
    });
  });
});

const NOW = "2026-08-13T00:00:00.000Z";

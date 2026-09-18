import { useCallback, useEffect, useRef, useState } from "react";
import type {
  WorkbenchPage,
  WorkbenchScope,
} from "../../shared/HelarcWorkbench.js";

export function useWorkbench(
  scope: WorkbenchScope | null,
  revision: number,
  descendants = false,
  enabled = true,
) {
  const [page, setPage] = useState<WorkbenchPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const flight = useRef(false);
  const loaded = useRef({ scopeKey: "", count: 0 });
  const scopeKey = scope
    ? JSON.stringify([
        scope.threadId,
        scope.productRunId,
        scope.runId,
        descendants,
      ])
    : "";
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    const current = ++generation.current;
    if (!scope || !enabled || !window.helarc) {
      setPage(null);
      return;
    }
    flight.current = true;
    setBusy(true);
    const retainCount =
      loaded.current.scopeKey === scopeKey ? loaded.current.count : 0;
    void (async () => {
      let result = await window.helarc.readRunWorkbench({
        ...scope,
        includeDescendants: descendants,
        cursor: null,
      });
      while (
        result.status === "page" &&
        result.nextCursor &&
        pageSize(result) < retainCount &&
        current === generation.current
      ) {
        const next = await window.helarc.readRunWorkbench({
          ...scope,
          includeDescendants: descendants,
          cursor: result.nextCursor,
        });
        if (next.status !== "page") break;
        result = mergePage(result, next);
      }
      return result;
    })()
      .then((result) => {
        if (current !== generation.current) return;
        if (result.status === "page") {
          loaded.current = { scopeKey, count: pageSize(result) };
          setPage(result);
          setError(null);
        } else {
          setPage(null);
          setError(result.code);
        }
      })
      .catch(() => {
        if (current === generation.current) setError("read_failed");
      })
      .finally(() => {
        if (current === generation.current) {
          setBusy(false);
          flight.current = false;
        }
      });
    return () => {
      generation.current++;
    };
  }, [scopeKey, revision, enabled, refreshKey]);
  const loadMore = useCallback(async () => {
    if (!scope || !page?.nextCursor || flight.current) return;
    flight.current = true;
    setBusy(true);
    const current = generation.current;
    try {
      const result = await window.helarc.readRunWorkbench({
        ...scope,
        includeDescendants: descendants,
        cursor: page.nextCursor,
      });
      if (current !== generation.current) return;
      if (result.status === "page") {
        const merged = mergePage(page, result);
        loaded.current = { scopeKey, count: pageSize(merged) };
        setPage(merged);
      } else if (result.code === "stale_cursor")
        setRefreshKey((value) => value + 1);
      else setError(result.code);
    } catch {
      if (current === generation.current) setError("read_failed");
    } finally {
      if (current === generation.current) {
        flight.current = false;
        setBusy(false);
      }
    }
  }, [scopeKey, page, descendants]);
  const matching =
    page &&
    scope &&
    page.scope.threadId === scope.threadId &&
    page.scope.productRunId === scope.productRunId &&
    page.scope.runId === scope.runId
      ? page
      : null;
  return {
    page: matching,
    error,
    busy,
    loadMore,
    refresh: () => setRefreshKey((value) => value + 1),
  };
}

function pageSize(page: WorkbenchPage): number {
  return page.records.length + page.commands.length + page.activity.length;
}
function mergePage(
  previous: WorkbenchPage,
  next: WorkbenchPage,
): WorkbenchPage {
  return {
    ...next,
    records: [...previous.records, ...next.records],
    commands: [...previous.commands, ...next.commands],
    activity: [...previous.activity, ...next.activity],
  };
}

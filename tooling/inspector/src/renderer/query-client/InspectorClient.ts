import type { InspectionQuery, InspectionReadResult } from "@agent-anything/inspection/query";
import {InspectorReadQueue} from "./InspectorReadQueue.js";
const reads = new InspectorReadQueue();

export async function openInspectorSession(): Promise<void> {
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get("bootstrap");
  if (!token) return;
  history.replaceState(null, "", location.pathname);
  const response = await fetch("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }), cache: "no-store" });
  if (!response.ok) throw new Error("Local access expired. Reopen Inspector from its launcher.");
}
export async function inspectionQuery(query: InspectionQuery, signal?: AbortSignal): Promise<InspectionReadResult> {
  const body = JSON.stringify(query);
  return reads.run(async () => {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch("/api/inspection/query", { method: "POST", headers: { "Content-Type": "application/json" }, body, signal, cache: "no-store" });
      const result = await response.json();
      if (response.ok) return result as InspectionReadResult;
      if (result.code !== "inspection_query_busy" || attempt >= 2) throw new Error(result.code ?? "inspection_query_failed");
      await waitForReadSlot(50 * (attempt + 1), signal);
    }
  }, signal);
}

function waitForReadSlot(delay: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("inspection_query_cancelled"));
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); reject(new Error("inspection_query_cancelled")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", cancel); resolve(); }, delay);
    signal?.addEventListener("abort", cancel, {once: true});
  });
}

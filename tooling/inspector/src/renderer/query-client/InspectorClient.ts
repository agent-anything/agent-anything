import type { InspectionQuery, InspectionReadResult } from "@agent-anything/inspection/query";

export async function openInspectorSession(): Promise<void> {
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get("bootstrap");
  if (!token) return;
  history.replaceState(null, "", location.pathname);
  const response = await fetch("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }), cache: "no-store" });
  if (!response.ok) throw new Error("Local access expired. Reopen Inspector from its launcher.");
}
export async function inspectionQuery(query: InspectionQuery, signal?: AbortSignal): Promise<InspectionReadResult> {
  const response = await fetch("/api/inspection/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(query), signal, cache: "no-store" });
  const result = await response.json();
  if (!response.ok) throw new Error(result.code ?? "inspection_query_failed");
  return result as InspectionReadResult;
}

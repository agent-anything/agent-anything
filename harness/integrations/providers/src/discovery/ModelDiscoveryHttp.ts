export async function readModelMetadata(
  url: string, apiKey: string, body: unknown | undefined, signal: AbortSignal | undefined,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<unknown> {
  const endpoint = new URL(url);
  if (!["https:", "http:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new TypeError("Invalid model discovery endpoint.");
  }
  const response = await fetchImpl(url, {
    method: body === undefined ? "GET" : "POST",
    redirect: "error",
    headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
  }).catch(() => { throw new Error("Model discovery transport is unavailable."); });
  if (!response.ok) throw new Error(`Model discovery failed (HTTP ${response.status}).`);
  if (!response.body) throw new Error("Model discovery returned no body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 2 * 1024 * 1024) throw new Error("Model discovery response exceeds its size limit.");
      text += decoder.decode(part.value, { stream: true });
    }
    try { return JSON.parse(text + decoder.decode()) as unknown; }
    catch { throw new TypeError("Model discovery returned invalid JSON."); }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function modelText(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512) throw new TypeError("Invalid model metadata text.");
  return value;
}
export function positiveCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}
export const unknownThinking = Object.freeze({ status: "unknown" as const, values: Object.freeze([]), defaultValue: null, source: "unknown" as const });

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, relative, isAbsolute } from "node:path";
import { InspectionQueryService, type InspectionQuery } from "@agent-anything/inspection/query";

export interface InspectorServerOptions { readonly root?: string; readonly assets: string; readonly port?: number; readonly bootstrapLifetimeMs?: number }
export interface InspectorServer { readonly url: string; readonly launchUrl: string; close(): Promise<void> }
const mime: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".ttf": "font/ttf", ".json": "application/json", ".txt": "text/plain" };
const codes: Record<string, number> = { inspection_query_invalid: 400, inspection_cursor_invalid: 400, inspection_access_denied: 403, inspection_reference_unknown: 404, inspection_source_unavailable: 404, inspection_dataset_unavailable: 404, inspection_dataset_cleared: 410, inspection_dataset_unsupported: 409, inspection_cursor_reset: 409, inspection_query_too_large: 413, inspection_query_busy: 503, inspection_query_timeout: 504, inspection_dataset_corrupt: 409 };

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";")[0] !== "application/json") throw new Error("inspection_query_invalid");
  const buffers: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) { bytes += chunk.length; if (bytes > 256 * 1024) throw new Error("inspection_query_too_large"); buffers.push(chunk); }
  try { return JSON.parse(Buffer.concat(buffers).toString("utf8")); } catch { throw new Error("inspection_query_invalid"); }
}
function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); response.end(JSON.stringify(value));
}

export async function startInspectorServer(options: InspectorServerOptions): Promise<InspectorServer> {
  const queries = new InspectionQueryService(options.root);
  const token = randomBytes(32).toString("base64url");
  const expires = Date.now() + (options.bootstrapLifetimeMs ?? 60_000);
  let consumed = false;
  const sessions = new Map<string, number>();
  const cookieName = `inspection_${randomBytes(8).toString("hex")}`;
  let origin = "";
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    void (async () => {
      if (request.headers.host !== new URL(origin).host) return json(response, 403, { code: "inspection_access_denied" });
      const url = new URL(request.url ?? "/", origin);
      if (url.pathname.startsWith("/api/")) {
        const suppliedOrigin = request.headers.origin;
        const fetchSite = request.headers["sec-fetch-site"];
        if (suppliedOrigin !== undefined && suppliedOrigin !== origin || fetchSite && !["same-origin", "none"].includes(String(fetchSite)) || request.method === "POST" && suppliedOrigin !== origin) return json(response, 403, { code: "inspection_access_denied" });
        if (url.pathname === "/api/session" && request.method === "POST") {
          const body = await jsonBody(request) as { token?: unknown };
          const supplied = typeof body?.token === "string" && body.token.length === token.length ? Buffer.from(body.token) : Buffer.alloc(0);
          if (consumed || Date.now() > expires || supplied.length !== token.length || !timingSafeEqual(supplied, Buffer.from(token))) return json(response, 401, { code: "inspection_session_required" });
          consumed = true;
          const session = randomBytes(32).toString("base64url"); sessions.set(session, Date.now() + 8 * 60 * 60 * 1000);
          response.setHeader("Set-Cookie", `${cookieName}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
          return json(response, 200, { authenticated: true });
        }
        const session = request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
        if (!session || (sessions.get(session) ?? 0) <= Date.now()) return json(response, 401, { code: "inspection_session_required" });
        if (url.pathname === "/api/session" && request.method === "DELETE") { sessions.delete(session); response.setHeader("Set-Cookie", `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`); return json(response, 200, { authenticated: false }); }
        if (url.pathname === "/api/inspection/health" && request.method === "GET") return json(response, 200, { available: true, mode: "manual" });
        const abort = new AbortController();
        response.on("close", () => { if (!response.writableEnded) abort.abort(); });
        if (url.pathname === "/api/inspection/query" && request.method === "POST") return json(response, 200, await queries.query(await jsonBody(request) as InspectionQuery, abort.signal));
        if (url.pathname.startsWith("/api/inspection/content/") && request.method === "GET") {
          return json(response, 200, await queries.query({ kind: "get_content", sourceId: url.searchParams.get("sourceId") ?? "", datasetId: url.searchParams.get("datasetId") ?? "", watermark: Number(url.searchParams.get("watermark")), contentId: url.pathname.slice("/api/inspection/content/".length), offset: Number(url.searchParams.get("offset") ?? 0) }, abort.signal));
        }
        return json(response, 404, { code: "inspection_route_unknown" });
      }
      if (request.method !== "GET" && request.method !== "HEAD") return json(response, 405, { code: "inspection_method_not_allowed" });
      const assets = resolve(options.assets);
      const file = resolve(assets, url.pathname === "/" ? "index.html" : `.${decodeURIComponent(url.pathname)}`);
      const rel = relative(assets, file);
      if (rel.startsWith("..") || isAbsolute(rel) || !mime[extname(file)]) return json(response, 404, { code: "inspection_asset_unknown" });
      try {
        if ((await stat(file)).size > 16 * 1024 * 1024) return json(response, 404, { code: "inspection_asset_unknown" });
        const bytes = await readFile(file);
        response.writeHead(200, { "Content-Type": `${mime[extname(file)]}; charset=utf-8` }); response.end(request.method === "HEAD" ? undefined : bytes);
      } catch { json(response, 404, { code: "inspection_asset_unknown" }); }
    })().catch((error: unknown) => {
      if (response.writableEnded || response.destroyed) return;
      const code = error instanceof Error && codes[error.message] ? error.message : "inspection_query_invalid";
      json(response, codes[code] ?? 400, { code });
    });
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port ?? 0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("inspection_listener_failed");
  origin = `http://127.0.0.1:${address.port}`;
  return { url: origin, launchUrl: `${origin}/#bootstrap=${token}`, close: async () => { sessions.clear(); await queries.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

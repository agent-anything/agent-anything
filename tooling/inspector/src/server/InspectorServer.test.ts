import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { get } from "node:http";
import { startInspectorServer, type InspectorServer } from "../../dist/server/InspectorServer.js";

const instances: InspectorServer[] = [];
afterEach(async () => { for (const instance of instances.splice(0)) await instance.close(); });
async function start() { const server = await startInspectorServer({ assets: fileURLToPath(new URL("../../dist/renderer", import.meta.url)) }); instances.push(server); return server; }
async function authenticate(server: InspectorServer) {
  const token = new URLSearchParams(new URL(server.launchUrl).hash.slice(1)).get("bootstrap");
  const response = await fetch(`${server.url}/api/session`, { method: "POST", headers: { Origin: server.url, "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
  expect(response.status).toBe(200); return response.headers.get("set-cookie")!.split(";")[0]!;
}
describe("Inspector local access", () => {
  it("requires local authentication, rejects cross-origin reads and has no control endpoints", async () => {
    const server = await start();
    expect((await fetch(`${server.url}/api/inspection/health`)).status).toBe(401);
    const cookie = await authenticate(server);
    expect((await fetch(`${server.url}/api/inspection/health`, { headers: { Cookie: cookie } })).status).toBe(200);
    expect((await fetch(`${server.url}/api/inspection/health`, { headers: { Cookie: cookie, Origin: "https://unrelated.example" } })).status).toBe(403);
    const invalidHost = await new Promise<number | undefined>((resolve, reject) => { get(`${server.url}/api/inspection/health`, { headers: { Cookie: cookie, Host: "evil.example" } }, (response) => { response.resume(); resolve(response.statusCode); }).on("error", reject); });
    expect(invalidHost).toBe(403);
    expect((await fetch(`${server.url}/api/execute`, { method: "POST", headers: { Cookie: cookie, Origin: server.url } })).status).toBe(404);
    const result = await fetch(`${server.url}/api/inspection/query`, { method: "POST", headers: { Cookie: cookie, Origin: server.url, "Content-Type": "application/json" }, body: JSON.stringify({ kind: "sql", sql: "SELECT *" }) });
    expect(result.status).toBe(400);
    expect(result.headers.get("cache-control")).toBe("no-store");
  });
  it("consumes bootstrap once and removes session authority on logout", async () => {
    const server = await start(); const cookie = await authenticate(server);
    const token = new URLSearchParams(new URL(server.launchUrl).hash.slice(1)).get("bootstrap");
    expect((await fetch(`${server.url}/api/session`, { method: "POST", headers: { Origin: server.url, "Content-Type": "application/json" }, body: JSON.stringify({ token }) })).status).toBe(401);
    expect((await fetch(`${server.url}/api/session`, { method: "DELETE", headers: { Cookie: cookie, Origin: server.url } })).status).toBe(200);
    expect((await fetch(`${server.url}/api/inspection/health`, { headers: { Cookie: cookie } })).status).toBe(401);
  });
});

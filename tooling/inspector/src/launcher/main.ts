import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { startInspectorServer } from "../server/InspectorServer.js";

const args = process.argv.slice(2);
const value = (flag: string): string | undefined => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
const port = value("--port");
if (port !== undefined && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) throw new Error("Inspector port must be between 1 and 65535.");
const server = await startInspectorServer({ root: value("--data-root") ? resolve(value("--data-root")!) : undefined, port: port ? Number(port) : undefined, assets: fileURLToPath(new URL("../renderer", import.meta.url)) });
process.stdout.write(`Inspector: ${server.url}\nOpen this one-use local access URL within 60 seconds:\n${server.launchUrl}\n`);
let closing = false;
const close = async () => { if (closing) return; closing = true; await server.close(); };
process.on("SIGINT", () => { void close(); }); process.on("SIGTERM", () => { void close(); });

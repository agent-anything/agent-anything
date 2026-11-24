import { parentPort, workerData } from "node:worker_threads";
import { ProviderRegistryDatabase } from "./ProviderRegistryDatabase.js";
import { ProviderConfigurationError } from "../../shared/ProviderConfiguration.js";
import type { ProviderRegistryCommand } from "./ProviderRegistryProtocol.js";

if (!parentPort) throw new Error("Provider registry requires a Worker.");
const port = parentPort;
try {
  const database = new ProviderRegistryDatabase(workerData.path);
  port.postMessage({ kind: "ready" });
  port.on("message", ({ id, command }: { id: number; command: ProviderRegistryCommand }) => {
    const start = performance.now();
    try {
      const value = database.execute(command);
      port.postMessage({ kind: "result", id, value, durationMs: performance.now() - start, work: database.work });
      if (command.kind === "close") port.close();
    } catch (error) {
      port.postMessage({ kind: "rejected", id, code: error instanceof ProviderConfigurationError ? error.code : "provider_registry_failed", durationMs: performance.now() - start, work: database.work });
    }
  });
} catch {
  port.postMessage({ kind: "startup_failed" }); port.close();
}

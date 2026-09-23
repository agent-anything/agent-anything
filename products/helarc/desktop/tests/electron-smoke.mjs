import { app, BrowserWindow } from "electron";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHelarcProvider } from "../dist/main/provider/createHelarcProvider.js";
import { FileHelarcThreadStore } from "../dist/main/thread/index.js";
import { fileURLToPath } from "node:url";
import { HelarcMainController } from "../dist/main/HelarcMainController.js";
import { registerHelarcIpc } from "../dist/main/ipc.js";
import { createHelarcWindowOptions } from "../dist/main/windowOptions.js";
if (process.env.HELARC_SMOKE_TRANSPORT_DIAGNOSTICS === "1") {
  const fetch = globalThis.fetch;
  globalThis.smokeTransportStats = [];
  globalThis.fetch = async (...args) => {
    const body = JSON.parse(args[1].body);
    const stats = {
      startedAt: Date.now(),
      responseAt: 0,
      firstChunkAt: 0,
      lastChunkAt: 0,
      chunks: 0,
      bytes: 0,
      stream: body.stream,
      systemMessages: body.messages.filter(
        (message) => message.role === "system",
      ).length,
    };
    globalThis.smokeTransportStats.push(stats);
    const response = await fetch(...args);
    stats.responseAt = Date.now();
    stats.contentType = response.headers.get("content-type");
    stats.transferEncoding = response.headers.get("transfer-encoding");
    return {
      ok: response.ok,
      status: response.status,
      headers: response.headers,
      json: () => response.json(),
      body: response.body?.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            stats.firstChunkAt ||= Date.now();
            stats.lastChunkAt = Date.now();
            stats.chunks++;
            stats.bytes += chunk.byteLength;
            controller.enqueue(chunk);
          },
        }),
      ),
    };
  };
}
app.setPath("userData", process.env.HELARC_SMOKE_USER_DATA);
void app
  .whenReady()
  .then(async () => {
    const window = new BrowserWindow(
      createHelarcWindowOptions(
        fileURLToPath(new URL("../dist/preload/preload.cjs", import.meta.url)),
      ),
    );
    const endpoint = process.env.HELARC_SMOKE_ENDPOINT;
    const providerKind = process.env.HELARC_SMOKE_PROVIDER_KIND ?? "ollama";
    const model = process.env.HELARC_SMOKE_MODEL ?? "test-model";
    const timeoutMs = Number(process.env.HELARC_SMOKE_TIMEOUT_MS ?? 10000);
    const ollamaRuntime =
      providerKind === "ollama"
        ? {
            contextWindowTokens: Number(
              process.env.HELARC_SMOKE_CONTEXT_WINDOW ?? 163840,
            ),
            maximumOutputTokens: Number(
              process.env.HELARC_SMOKE_OUTPUT_TOKENS ?? 2048,
            ),
          }
        : null;
    const controller = new HelarcMainController(
      endpoint
        ? {
            responseDelivery: "streaming",
            providerProfile: {
              id: "test-provider",
              providerKind,
              displayName: "Smoke Provider",
              baseUrl: endpoint,
              baseUrlOrigin: endpoint,
              endpointLabel: "127.0.0.1",
              model,
              timeoutMs,
              ollamaRuntime,
              credentialStatus: "empty_allowed",
              qualificationPolicy: "allow_experimental",
              isActive: true,
            },
            threadStore: new FileHelarcThreadStore(
              join(app.getPath("userData"), "threads.json"),
            ),
            provider: createHelarcProvider({
              providerKind,
              baseUrl: endpoint,
              model,
              timeoutMs,
              apiKey: "",
              ollamaRuntime,
            }),
          }
        : {},
    );
    if (endpoint) {
      const workspace = join(app.getPath("userData"), "workspace");
      await mkdir(workspace, { recursive: true });
      controller.selectWorkspacePath(workspace);
    }
    registerHelarcIpc({ window, controller });
    await window.loadFile(
      fileURLToPath(new URL("../dist/renderer/index.html", import.meta.url)),
    );
    window.show();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });

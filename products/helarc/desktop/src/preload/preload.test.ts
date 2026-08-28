import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

interface ExposedHelarcApi {
  saveProviderConfig(input: Record<string, unknown>): Promise<unknown>;
}

describe("Helarc preload bridge", () => {
  it("forwards the complete Ollama Provider settings command", async () => {
    const source = await readFile(new URL("./preload.cjs", import.meta.url), "utf8");
    let exposedApi: ExposedHelarcApi | undefined;
    const invoke = vi.fn(async () => ({ status: "handled" }));

    runInNewContext(source, {
      require: (specifier: string) => {
        if (specifier !== "electron") {
          throw new Error(`Unexpected preload dependency: ${specifier}`);
        }
        return {
          contextBridge: {
            exposeInMainWorld: (key: string, value: ExposedHelarcApi) => {
              if (key === "helarc") exposedApi = value;
            },
          },
          ipcRenderer: {
            invoke,
            on: vi.fn(),
            removeListener: vi.fn(),
          },
        };
      },
    });

    const input = {
      commandId: "provider-save-1",
      providerKind: "ollama",
      displayName: "Local Gemma",
      baseUrl: "http://localhost:11434",
      model: "gemma4:e4b",
      timeoutMs: 30_000,
      ollamaRuntime: {
        contextWindowTokens: 16_384,
        maximumOutputTokens: 2_048,
      },
      qualificationPolicy: "allow_experimental",
      apiKeyUpdate: "clear",
      apiKey: "",
    };

    await exposedApi?.saveProviderConfig(input);

    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]?.[0]).toBe("helarc:save-provider-config");
    expect(invoke.mock.calls[0]?.[1]).toEqual({
      version: 1,
      commandId: "provider-save-1",
      kind: "provider.save",
      payload: {
        providerKind: "ollama",
        displayName: "Local Gemma",
        baseUrl: "http://localhost:11434",
        model: "gemma4:e4b",
        timeoutMs: 30_000,
        ollamaRuntime: {
          contextWindowTokens: 16_384,
          maximumOutputTokens: 2_048,
        },
        qualificationPolicy: "allow_experimental",
        apiKeyUpdate: "clear",
        apiKey: "",
      },
    });
  });
});

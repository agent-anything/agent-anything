import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

interface ExposedHelarcApi {
  getInstructionSettings(): Promise<unknown>;
  saveInstructionSettings(input: Record<string, unknown>): Promise<unknown>;
  saveProviderConfig(input: Record<string, unknown>): Promise<unknown>;
  resumeDescendant(input: Record<string, unknown>): Promise<unknown>;
}

describe("Helarc preload bridge", () => {
  it("forwards instruction settings without interpreting enabled flags", async () => {
    const source = await readFile(new URL("./preload.cjs", import.meta.url), "utf8");
    let api: ExposedHelarcApi | undefined;
    const invoke = vi.fn(async () => ({ status: "handled" }));
    runInNewContext(source, { require: () => ({
      contextBridge: { exposeInMainWorld: (_key: string, value: ExposedHelarcApi) => { api = value; } },
      ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() },
    }) });
    const settings = { agent: [{ id: "identity_and_role", enabled: false, content: "Keep my text." }], delegated: [], protocol: [] };
    await api!.getInstructionSettings();
    await api!.saveInstructionSettings({ commandId: "instructions-1", settings });
    expect(invoke).toHaveBeenCalledWith("helarc:get-instruction-settings");
    expect(invoke).toHaveBeenCalledWith("helarc:save-instruction-settings", {
      version: 1, commandId: "instructions-1", kind: "instructions.save", payload: { settings },
    });
  });
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

  it("forwards exact descendant identity and suspension revision", async () => {
    const source = await readFile(new URL("./preload.cjs", import.meta.url), "utf8");
    let exposedApi: ExposedHelarcApi | undefined;
    const invoke = vi.fn(async () => ({ status: "handled" }));

    runInNewContext(source, {
      require: () => ({
        contextBridge: {
          exposeInMainWorld: (_key: string, value: ExposedHelarcApi) => {
            exposedApi = value;
          },
        },
        ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() },
      }),
    });

    await exposedApi?.resumeDescendant({
      commandId: "resume-1",
      runId: "run-root",
      request: { id: "request-1", revision: "request-1-v1" },
      relation: { id: "relation-1" },
      child: { id: "run-child" },
      expectedRunRevision: 5,
      suspension: { id: "suspension-1", revision: "suspension-1-v1" },
      reason: "Resume from desktop.",
    });

    expect(invoke).toHaveBeenCalledWith("helarc:resume-descendant", {
      version: 1,
      commandId: "resume-1",
      runId: "run-root",
      kind: "descendant.resume",
      payload: {
        request: { id: "request-1", revision: "request-1-v1" },
        relation: { id: "relation-1" },
        child: { id: "run-child" },
        expectedRunRevision: 5,
        suspension: {
          run: { id: "run-child" },
          id: "suspension-1",
          revision: "suspension-1-v1",
        },
        reason: "Resume from desktop.",
      },
    });
  });
});

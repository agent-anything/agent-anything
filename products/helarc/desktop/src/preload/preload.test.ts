import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import type { HelarcDesktopApi } from "../shared/HelarcDesktopApi.js";

interface ExposedHelarcApi {
  getInstructionSettings(): Promise<unknown>;
  saveInstructionSettings(input: Record<string, unknown>): Promise<unknown>;
  saveProviderConfig(input: Record<string, unknown>): Promise<unknown>;
  resumeDescendant(input: Record<string, unknown>): Promise<unknown>;
}

describe("Helarc preload bridge", () => {
  it("forwards owned operation sections through the read-only detail route", async () => {
    const source = await readFile(new URL("./preload.cjs", import.meta.url), "utf8");
    let api!: HelarcDesktopApi;
    const invoke = vi.fn(async () => ({ status: "page" }));
    runInNewContext(source, { require: () => ({
      contextBridge: { exposeInMainWorld: (_key: string, value: HelarcDesktopApi) => { api = value; } },
      ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() },
    }) });
    const query = { threadId: "thread", productRunId: "work", runId: "child", itemId: "call", section: "request", offset: 8192 };
    await api.readWorkbenchItem(query);
    expect(invoke).toHaveBeenCalledWith("helarc:read-workbench-item", query);
  });
  it("forwards Project identity and folder references through named commands", async () => {
    const source = await readFile(new URL("./preload.cjs", import.meta.url), "utf8");
    let api!: HelarcDesktopApi;
    const invoke = vi.fn(async () => ({ status: "handled" }));
    runInNewContext(source, { require: () => ({
      contextBridge: { exposeInMainWorld: (_key: string, value: HelarcDesktopApi) => { api = value; } },
      ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() },
    }) });
    const input = { commandId: "save", id: "project", expectedRevision: 3, name: "Name", primaryProfileId: "a", additionalProfileIds: ["b"], path: "D:/forged" };
    await api.saveProject(input);
    expect(invoke).toHaveBeenCalledWith("helarc:save-project", { version: 1, commandId: "save", kind: "project.save", payload: { id: "project", expectedRevision: 3, name: "Name", primaryProfileId: "a", additionalProfileIds: ["b"] } });
    await api.chooseProjectFolder({ commandId: "folder" });
    expect(invoke).toHaveBeenLastCalledWith("helarc:choose-project-folder", { version: 1, commandId: "folder", kind: "project.chooseFolder", payload: {} });
    await api.selectProject({ commandId: "select", projectId: "project" });
    expect(invoke).toHaveBeenLastCalledWith("helarc:select-project", { version: 1, commandId: "select", kind: "project.select", payload: { projectId: "project" } });
  });
  it("registers response delivery before acknowledgement and filters scope without exposing Electron events", async () => {
    const source = await readFile(new URL("./preload.cjs", import.meta.url), "utf8");
    let api!: HelarcDesktopApi;
    let deliver!: (event: unknown, frame: unknown) => void;
    const order: string[] = [];
    const on = vi.fn((_channel, listener) => { order.push("listen"); deliver = listener; });
    const removeListener = vi.fn();
    const listener = vi.fn();
    const scope = {threadId:"thread", productRunId:"work"};
    const invoke = vi.fn(async (channel: string, input: Record<string, unknown>) => {
      order.push(channel);
      if (channel === "helarc:subscribe-response-progress") {
        deliver({secret:"electron-event"}, {subscriptionId:input.subscriptionId,scope,sequence:1});
        return {status:"subscribed"};
      }
      return {status:"page"};
    });
    runInNewContext(source, {require:() => ({
      contextBridge:{exposeInMainWorld:(_key: string,value:HelarcDesktopApi) => {api=value;}},
      ipcRenderer:{invoke,on,removeListener},
    })});
    const result = await api.subscribeResponseProgress(scope,listener);
    expect(order.slice(0,2)).toEqual(["listen","helarc:subscribe-response-progress"]);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({subscriptionId:"response-1",scope,sequence:1});
    deliver({}, {subscriptionId:"response-1",scope:{...scope,threadId:"foreign"}});
    deliver({}, {subscriptionId:"foreign",scope});
    expect(listener).toHaveBeenCalledOnce();
    await api.readResponsePreview({...scope,runId:"child",invocationId:null,cursor:null});
    expect(invoke).toHaveBeenLastCalledWith("helarc:read-response-preview",{...scope,runId:"child",invocationId:null,cursor:null});
    if (result.status !== "subscribed") throw new Error("Subscription failed");
    result.dispose();result.dispose();
    expect(removeListener).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenLastCalledWith("helarc:unsubscribe-response-progress",{subscriptionId:"response-1"});
    deliver({}, {subscriptionId:"response-1",scope});
    expect(listener).toHaveBeenCalledOnce();
  });

  it("removes response listeners when subscription is refused", async () => {
    const source = await readFile(new URL("./preload.cjs", import.meta.url), "utf8");
    let api!: HelarcDesktopApi;
    const removeListener = vi.fn();
    runInNewContext(source,{require:() => ({
      contextBridge:{exposeInMainWorld:(_key:string,value:HelarcDesktopApi) => {api=value;}},
      ipcRenderer:{on:vi.fn(),removeListener,invoke:async () => ({status:"rejected",code:"not_found"})},
    })});
    expect(await api.subscribeResponseProgress({threadId:"thread",productRunId:"missing"},vi.fn())).toMatchObject({code:"not_found"});
    expect(removeListener).toHaveBeenCalledOnce();
  });
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

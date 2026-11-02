import {describe, expect, it, vi, afterEach} from "vitest";
import {InspectorReadQueue} from "./InspectorReadQueue.js";
import {inspectionQuery} from "./InspectorClient.js";

afterEach(() => {vi.unstubAllGlobals();});
describe("Inspector read dispatch", () => {
  it("bounds active and queued reads, removes cancelled work and releases failed slots", async () => {
    const queue = new InspectorReadQueue(1, 1);
    let release!: () => void;
    const first = queue.run(() => new Promise<void>(resolve => {release=resolve;}));
    const abort = new AbortController(), cancelled = vi.fn(async () => 2);
    const second = queue.run(cancelled, abort.signal);
    await expect(queue.run(async () => 3)).rejects.toThrow("inspection_query_busy");
    const stopped = expect(second).rejects.toThrow("inspection_query_cancelled"); abort.abort(); await stopped;
    const failed = queue.run(async () => {throw new Error("read failed");});
    const failure = expect(failed).rejects.toThrow("read failed");
    release(); await first; await failure;
    expect(cancelled).not.toHaveBeenCalled();
    expect(await queue.run(async () => 4)).toBe(4);
  });
  it("retries only transient busy with the identical fixed request and a finite bound", async () => {
    const fetch = vi.fn(async () => ({ok:false,json:async()=>({code:"inspection_query_busy"})})); vi.stubGlobal("fetch",fetch);
    await expect(inspectionQuery({kind:"list_sources"})).rejects.toThrow("inspection_query_busy");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(new Set(fetch.mock.calls.map(call=>(call as unknown as [string,RequestInit])[1].body)).size).toBe(1);
  });
  it("does not retry denied reads or continue a cancelled busy wait", async () => {
    const fetch = vi.fn(async () => ({ok:false,json:async()=>({code:"inspection_access_denied"})})); vi.stubGlobal("fetch",fetch);
    await expect(inspectionQuery({kind:"list_sources"})).rejects.toThrow("inspection_access_denied");
    expect(fetch).toHaveBeenCalledTimes(1);
    const abort = new AbortController();
    fetch.mockImplementation(async () => {abort.abort();return {ok:false,json:async()=>({code:"inspection_query_busy"})};});
    await expect(inspectionQuery({kind:"list_sources"},abort.signal)).rejects.toThrow("inspection_query_cancelled");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

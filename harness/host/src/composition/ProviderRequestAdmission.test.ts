import {describe, it, expect, vi} from "vitest";
import {ProviderRequestAdmission} from "./ProviderRequestAdmission.js";

const policy = {revision: "test", maximumActive: 2, maximumBackground: 1, maximumQueued: 3};
describe("Shared Provider admission", () => {
  it("reserves ordinary capacity, prioritizes foreground and retains unconfirmed leases", async () => {
    const admission = new ProviderRequestAdmission(policy), signal = new AbortController().signal;
    const first = await admission.acquire({id: "bg1", background: true, signal});
    const bg = vi.fn(), fg = vi.fn();
    const background = admission.acquire({id: "bg2", background: true, signal}).then(lease => {bg(); return lease;});
    const second = await admission.acquire({id: "fg1", background: false, signal});
    const foreground = admission.acquire({id: "fg2", background: false, signal}).then(lease => {fg(); return lease;});
    expect(bg).not.toHaveBeenCalled(); first.settle("confirmed");
    const third = await foreground;
    expect(fg).toHaveBeenCalledOnce(); expect(bg).not.toHaveBeenCalled();
    second.settle("confirmed"); const fourth = await background;
    fourth.settle("unconfirmed"); third.settle("confirmed");
    expect(admission.snapshot()).toEqual({active: 1, background: 1, queued: 0, unconfirmed: 1});
  });
  it("removes cancelled queue entries without dispatching and bounds queue size", async () => {
    const admission = new ProviderRequestAdmission({...policy, maximumQueued: 1}), signal = new AbortController().signal;
    const a = await admission.acquire({id: "a", background: false, signal});
    const b = await admission.acquire({id: "b", background: false, signal});
    const cancellation = new AbortController();
    const queued = admission.acquire({id: "queued", background: true, signal: cancellation.signal});
    await expect(admission.acquire({id: "extra", background: false, signal})).rejects.toThrow("queue_full");
    cancellation.abort(new Error("cancelled")); await expect(queued).rejects.toThrow("cancelled");
    a.settle("confirmed"); b.settle("confirmed"); expect(admission.snapshot().queued).toBe(0);
  });
});

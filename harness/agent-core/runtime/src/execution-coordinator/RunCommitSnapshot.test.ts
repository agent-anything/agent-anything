import {describe, expect, it} from "vitest";
import {retainControllerCheckpoint, snapshotRunCommit} from "./RunCommitSnapshot.js";
import type {RunCommit} from "./RunCommitPort.js";

describe("Controller checkpoint ownership", () => {
  it("snapshots external values once and shares only locally owned immutable values", () => {
    const input = {request: {messages: [{content: "original"}]}};
    const retained = retainControllerCheckpoint(input);
    input.request.messages[0]!.content = "changed";
    expect(retained.request.messages[0]!.content).toBe("original");
    expect(retainControllerCheckpoint(retained)).toBe(retained);
    expect(() => {retained.request.messages[0]!.content = "changed";}).toThrow();
  });
  it("does not trust a caller's shallow frozen flag", () => {
    const child = {value: 1};
    const retained = retainControllerCheckpoint(Object.freeze({child}));
    child.value = 2;
    expect(retained.child.value).toBe(1);
    expect(Object.isFrozen(retained.child)).toBe(true);
  });
  it("shares retained Controller history across commits but snapshots the changing state", () => {
    const value = retainControllerCheckpoint({response: {content: "retained"}});
    const state = {revision: 1};
    const input = {state, control: {controllerCheckpoints: [["turn", value]]}} as unknown as RunCommit;
    const first = snapshotRunCommit(input);
    state.revision = 2;
    const second = snapshotRunCommit(input);
    expect(first.state.revision).toBe(1);
    expect(second.state.revision).toBe(2);
    expect(second.control.controllerCheckpoints[0]![1]).toBe(first.control.controllerCheckpoints[0]![1]);
    expect(snapshotRunCommit(second)).toBe(second);
    expect(() => {(second.state as {revision: number}).revision = 3;}).toThrow();
  });
  it("shares proven immutable history and bindings without trusting shallow freezes", () => {
    const history = Object.freeze({payload: Object.freeze({text: "accepted"})});
    const binding = Object.freeze({revision: "one"});
    const mutable = {value: 1}, shallow = Object.freeze({mutable});
    const make = (revision: number) => ({state: {revision, items: [history]}, control: {binding, shallow}}) as unknown as RunCommit;
    const first = snapshotRunCommit(make(1));
    mutable.value = 2;
    const second = snapshotRunCommit(make(2));
    expect(second.state.items[0]).toBe(first.state.items[0]);
    expect(second.control).not.toBe(first.control);
    expect((second.control as any).binding).toBe((first.control as any).binding);
    expect((first.control as any).shallow.mutable.value).toBe(1);
    expect((second.control as any).shallow.mutable.value).toBe(2);
  });
  it("does not memoize frozen accessors, special objects or executable proxies", () => {
    let value = 1;
    const source = Object.freeze({get value() {return value;}});
    expect(retainControllerCheckpoint(source).value).toBe(1);
    value = 2;
    expect(retainControllerCheckpoint(source).value).toBe(2);
    const date = Object.freeze(new Date(0));
    expect(retainControllerCheckpoint(date).getTime()).toBe(0);
    date.setTime(1);
    expect(retainControllerCheckpoint(date).getTime()).toBe(1);
    const trap = () => {throw new Error("proxy trap ran");};
    expect(() => retainControllerCheckpoint(new Proxy({}, {ownKeys: trap}))).toThrow();
  });
});

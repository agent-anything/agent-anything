import {types} from "node:util";
import type {RunCommit} from "./RunCommitPort.js";
import type {RunTreeCommit} from "./RunTreeCommitPort.js";

const owned = new WeakSet<object>();
const immutableSources = new WeakMap<object, object>();

/** Controller data crosses the ownership boundary once, not on every Run revision. */
export function retainControllerCheckpoint<T>(value: T): T {
  return snapshot(value);
}

export function snapshotRunCommit(commit: RunCommit): RunCommit {
  return snapshot(commit);
}

export function snapshotRunTreeCommit(commit: RunTreeCommit): RunTreeCommit {
  return snapshot(commit);
}

function snapshot<T>(input: T): T {
  const copies = new WeakMap<object, {value: object; immutable: boolean; plain: boolean}>();
  const visit = (value: unknown): {value: unknown; immutable: boolean; plain: boolean} => {
    if (value === null || typeof value !== "object") return {
      value: typeof value === "function" || typeof value === "symbol" ? structuredClone(value) : value, immutable: true, plain: true};
    if (owned.has(value)) return {value, immutable: true, plain: true};
    const retained = immutableSources.get(value);
    if (retained) return {value: retained, immutable: true, plain: true};
    const previous = copies.get(value);
    if (previous) return previous;
    // Preserve structuredClone's rejection/handling of special inputs; only
    // ordinary data properties can establish persistent identity evidence.
    if (types.isProxy(value)) return {value: structuredClone(value), immutable: false, plain: false};
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value).filter(key => !array || key !== "length");
    if ((!array && prototype !== Object.prototype && prototype !== null) ||
        array && (prototype !== Array.prototype || keys.length !== value.length) ||
        keys.some(key => typeof key !== "string" || !descriptors[key]!.enumerable || !("value" in descriptors[key]!) ||
          array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) {
      return {value: freezeCopy(structuredClone(value)), immutable: false, plain: false};
    }
    const result = array ? [] : {};
    const entry = {value: result, immutable: false, plain: false};
    copies.set(value, entry);
    let immutable = Object.isFrozen(value), plain = true;
    for (const key of keys as string[]) {
      const child = visit(descriptors[key]!.value);
      Object.defineProperty(result, key, {value: child.value, enumerable: true, writable: true, configurable: true});
      immutable &&= child.immutable; plain &&= child.plain;
    }
    Object.freeze(result);
    entry.immutable = immutable && plain; entry.plain = plain;
    if (plain) owned.add(result);
    if (entry.immutable) immutableSources.set(value, result);
    return entry;
  };
  return visit(input).value as T;
}

function freezeCopy<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezeCopy(child, seen);
  return Object.freeze(value);
}

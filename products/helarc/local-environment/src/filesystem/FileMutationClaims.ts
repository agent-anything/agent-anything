import { resolve } from "node:path";
import type { FileBaseline } from "@agent-anything/canonical-action/subject";

/** Serializes participating Host mutations, not arbitrary external writers. */
export class FileMutationClaims {
  private readonly pending = new Map<string, Promise<void>>();

  async execute<T>(path: string, baseline: FileBaseline, work: () => Promise<T>): Promise<T> {
    const canonical = resolve(path);
    const keys = [`path:${process.platform === "win32" ? canonical.toLowerCase() : canonical}`];
    if (baseline.kind === "present") {
      const identity = baseline.objectIdentity;
      keys.push(identity.kind === "win32" ? `object:win32:${identity.volumeId}:${identity.fileId}` :
        `object:posix:${identity.deviceId}:${identity.inode}`);
    }
    const previous = [...new Set(keys.map(key => this.pending.get(key)).filter(value => value !== undefined))];
    let release!: () => void;
    const settled = new Promise<void>(resolve => {release = resolve;});
    for (const key of keys) this.pending.set(key, settled);
    try {
      for (const wait of previous) await wait;
      return await work();
    } finally {
      release();
      for (const key of keys) if (this.pending.get(key) === settled) this.pending.delete(key);
    }
  }
}

// All capability instances in this Host share the same mutation owner.
export const hostFileMutationClaims = new FileMutationClaims();

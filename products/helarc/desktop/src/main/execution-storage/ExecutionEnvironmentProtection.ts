import {createHash} from "node:crypto";
import type {CommandEnvironmentRecoverySnapshot, ProcessCheckpoint} from "@agent-anything/helarc-local-environment/command";

export interface ExecutionEnvironmentCipher {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): string;
  decryptString(value: string): string;
}
export interface ProtectedExecutionEnvironment {
  readonly version: 1;
  readonly digest: string;
  readonly ciphertext: string;
}
export type RetainedCommandEnvironment = Omit<CommandEnvironmentRecoverySnapshot, "environment"> & {readonly environment: ProtectedExecutionEnvironment};
export type StoredProcessCheckpoint = ProcessCheckpoint<ProtectedExecutionEnvironment>;

export class ExecutionEnvironmentProtectionError extends Error {
  constructor(readonly code: string) { super(`Execution environment protection failed (${code}).`); this.name = "ExecutionEnvironmentProtectionError"; }
}

export function validateProtectedEnvironment(value: ProtectedExecutionEnvironment): void {
  if (!value || value.version !== 1 || !/^sha256:[0-9a-f]{64}$/.test(value.digest) || typeof value.ciphertext !== "string" || !value.ciphertext.length)
    throw new ExecutionEnvironmentProtectionError("execution_environment_snapshot_invalid");
}

function encode(values: Readonly<Record<string, string>>): string {
  if (!values || typeof values !== "object" || Array.isArray(values) || Object.entries(values).some(([key, value]) => !key || typeof value !== "string"))
    throw new ExecutionEnvironmentProtectionError("execution_environment_snapshot_invalid");
  return JSON.stringify(Object.fromEntries(Object.entries(values).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
}
function digest(text: string): string { return `sha256:${createHash("sha256").update(text).digest("hex")}`; }

/** Seals before Worker transfer; plaintext never becomes a persistence command. */
export class ExecutionEnvironmentProtection {
  private readonly sealed = new Map<string, ProtectedExecutionEnvironment>();
  constructor(private readonly cipher?: ExecutionEnvironmentCipher) {}
  protect(values: Readonly<Record<string, string>>): ProtectedExecutionEnvironment {
    const text = encode(values);
    const id = digest(text);
    const existing = this.sealed.get(id);
    if (existing) return existing;
    if (!this.cipher?.isEncryptionAvailable()) throw new ExecutionEnvironmentProtectionError("execution_environment_encryption_unavailable");
    let ciphertext: string;
    try { ciphertext = this.cipher.encryptString(text); }
    catch { throw new ExecutionEnvironmentProtectionError("execution_environment_encryption_failed"); }
    const value = Object.freeze({version: 1 as const, digest: id, ciphertext});
    validateProtectedEnvironment(value);
    this.sealed.set(id, value);
    return value;
  }
  restore(value: ProtectedExecutionEnvironment): Readonly<Record<string, string>> {
    validateProtectedEnvironment(value);
    if (!this.cipher?.isEncryptionAvailable()) throw new ExecutionEnvironmentProtectionError("execution_environment_decryption_unavailable");
    let values: Readonly<Record<string, string>>;
    try { values = JSON.parse(this.cipher.decryptString(value.ciphertext)); }
    catch { throw new ExecutionEnvironmentProtectionError("execution_environment_decryption_failed"); }
    if (digest(encode(values)) !== value.digest) throw new ExecutionEnvironmentProtectionError("execution_environment_digest_mismatch");
    // Reuse the exact sealed representation for an acknowledged record replay.
    this.sealed.set(value.digest, value);
    return Object.freeze({...values});
  }
  retainSnapshot(snapshot: CommandEnvironmentRecoverySnapshot): RetainedCommandEnvironment {
    return {...snapshot, environment: this.protect(snapshot.environment)};
  }
  restoreSnapshot(snapshot: RetainedCommandEnvironment): CommandEnvironmentRecoverySnapshot {
    if (!snapshot) throw new ExecutionEnvironmentProtectionError("execution_environment_snapshot_missing");
    return {...snapshot, environment: this.restore(snapshot.environment)};
  }
}

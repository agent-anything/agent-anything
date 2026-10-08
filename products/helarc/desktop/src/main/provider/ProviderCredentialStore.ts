import type { HelarcCredentialSelection } from "../../shared/HelarcProviderCredentials.js";
import { snapshotCredentialSelection } from "../../shared/HelarcProviderCredentials.js";
import { SafeStorageCredentialBackend, type ProviderCredentialStoreError as SafeStorageError,
  type ResolveProviderCredentialResult as SafeStorageResult } from "./SafeStorageCredentialBackend.js";

export type ProviderCredentialRef =
  | { readonly storage: "safe-storage"; readonly ownership: "managed"; readonly id: string }
  | { readonly storage: "windows"; readonly ownership: "managed" | "external"; readonly id: string; readonly encoding: "utf16le" | "utf8" };
export interface WindowsCredentialBackend {
  available(): Promise<boolean>;
  read(target: string, encoding: "utf16le" | "utf8"): Promise<string | null>;
  create(target: string, secret: string): Promise<void>;
  delete(target: string): Promise<void>;
}
export type ProviderCredentialStoreError = SafeStorageError | {
  code: "provider_credential_unavailable" | "provider_credential_missing" | "provider_credential_invalid";
  message: string;
};
type Result = SafeStorageResult | { ok: false; error: ProviderCredentialStoreError };
export class ProviderCredentialStore {
  constructor(private readonly local: SafeStorageCredentialBackend, private readonly windows?: WindowsCredentialBackend) {}
  async windowsAvailable(): Promise<boolean> { return this.windows?.available().catch(() => false) ?? false; }

  async resolveApiKey(ref: ProviderCredentialRef): Promise<Result> {
    if (ref.storage === "safe-storage") return this.local.resolveApiKey(ref.id);
    if (!await this.windowsAvailable()) return unavailable();
    try {
      const apiKey = await this.windows!.read(ref.id, ref.encoding);
      if (apiKey !== null && (!apiKey.trim() || /[\r\n\u0000]/u.test(apiKey))) return invalid();
      return { ok: true, apiKey, credentialStatus: apiKey === null ? "missing" : "present" };
    } catch { return unavailable(); }
  }

  async stage(id: string, apiKey: string, selection: HelarcCredentialSelection): Promise<
    { ok: true; ref: ProviderCredentialRef } | { ok: false; error: ProviderCredentialStoreError }> {
    if (selection.source === "windows-reference") return invalid();
    if (selection.source === "safe-storage") {
      const saved = await this.local.saveApiKey({ profileId: id, apiKey });
      return saved.ok ? { ok: true, ref: { storage: "safe-storage", ownership: "managed", id } } : saved;
    }
    if (!await this.windowsAvailable()) return unavailable();
    if (!apiKey || Buffer.byteLength(apiKey, "utf16le") > 2560 || /[\r\n\u0000]/u.test(apiKey)) return invalid();
    const ref: ProviderCredentialRef = { storage: "windows", ownership: "managed", id: `Helarc/Provider/${id}`, encoding: "utf16le" };
    try { await this.windows!.create(ref.id, apiKey); return { ok: true, ref }; }
    catch { return unavailable(); }
  }

  async deleteApiKey(ref: ProviderCredentialRef): Promise<void> {
    if (ref.ownership === "external") return;
    if (ref.storage === "safe-storage") {
      const removed = await this.local.deleteApiKey(ref.id);
      if (!removed.ok) throw new Error("Saved credential cleanup failed.");
    } else {
      if (!ref.id.startsWith("Helarc/Provider/") || !await this.windowsAvailable()) throw new Error("Windows credential cleanup unavailable.");
      await this.windows!.delete(ref.id);
    }
  }
}

export function selectionFor(ref: ProviderCredentialRef | null): HelarcCredentialSelection {
  return ref?.storage === "windows"
    ? ref.ownership === "external" ? { source: "windows-reference", target: ref.id, encoding: ref.encoding } : { source: "windows-managed" }
    : { source: "safe-storage" };
}

export function validCredentialRef(value: unknown, profileId: string): value is ProviderCredentialRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string") return false;
  const ownedId = new RegExp(`^${profileId}-[a-f0-9-]{36}$`);
  if (v.storage === "safe-storage") return Object.keys(v).sort().join() === "id,ownership,storage" && v.ownership === "managed" && ownedId.test(v.id);
  if (v.storage !== "windows" || Object.keys(v).sort().join() !== "encoding,id,ownership,storage") return false;
  if (v.ownership === "managed") return v.encoding === "utf16le" && v.id.startsWith("Helarc/Provider/") && ownedId.test(v.id.slice("Helarc/Provider/".length));
  try { return v.ownership === "external" && !!snapshotCredentialSelection({ source: "windows-reference", target: v.id, encoding: v.encoding }); }
  catch { return false; }
}
function unavailable() { return { ok: false as const, error: { code: "provider_credential_unavailable" as const, message: "Credential storage is unavailable or the selected entry cannot be decoded. Check its storage and encoding." } }; }
function invalid() { return { ok: false as const, error: { code: "provider_credential_invalid" as const, message: "Credential value or storage selection is invalid." } }; }

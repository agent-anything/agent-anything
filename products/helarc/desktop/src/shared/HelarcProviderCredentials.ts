export type HelarcCredentialSelection =
  | { readonly source: "safe-storage" | "windows-managed" }
  | { readonly source: "windows-reference"; readonly target: string; readonly encoding: "utf16le" | "utf8" };

export interface HelarcCredentialSettings {
  readonly windowsAvailable: boolean;
  readonly selection: HelarcCredentialSelection;
}

export function snapshotCredentialSelection(value: unknown): HelarcCredentialSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid credential selection.");
  const v = value as Record<string, unknown>;
  if ((v.source === "safe-storage" || v.source === "windows-managed") && Object.keys(v).length === 1) return { source: v.source };
  if (v.source === "windows-reference" && Object.keys(v).sort().join() === "encoding,source,target" &&
      (v.encoding === "utf16le" || v.encoding === "utf8") && typeof v.target === "string" &&
      v.target.length > 0 && v.target.length <= 2048 && v.target === v.target.trim() &&
      !/[\u0000-\u001f\u007f]/u.test(v.target) && !v.target.toLowerCase().startsWith("helarc/provider/")) {
    return { source: v.source, target: v.target, encoding: v.encoding };
  }
  throw new Error("Invalid credential selection or reserved Windows target.");
}

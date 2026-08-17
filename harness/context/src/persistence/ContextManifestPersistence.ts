import type { SafeProjectionManifest } from "../projection/SafeProjectionManifest.js";

export type ContextManifestPersistenceResult =
  | { readonly kind: "stored"; readonly recordId: string }
  | {
      readonly kind: "failed";
      readonly code: string;
      readonly message: string;
    };

export interface ContextManifestPersistencePort {
  persistManifest(
    manifest: SafeProjectionManifest,
  ): Promise<ContextManifestPersistenceResult>;
}

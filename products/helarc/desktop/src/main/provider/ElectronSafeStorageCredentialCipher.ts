import { safeStorage } from "electron";
import type { ProviderCredentialCipher } from "./ProviderCredentialStore.js";

export class ElectronSafeStorageCredentialCipher implements ProviderCredentialCipher {
  isEncryptionAvailable(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  encryptString(value: string): string {
    return safeStorage.encryptString(value).toString("base64");
  }

  decryptString(value: string): string {
    return safeStorage.decryptString(Buffer.from(value, "base64"));
  }
}

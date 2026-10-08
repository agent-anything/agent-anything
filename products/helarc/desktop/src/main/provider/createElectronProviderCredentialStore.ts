import { join } from "node:path";
import { ElectronSafeStorageCredentialCipher } from "./ElectronSafeStorageCredentialCipher.js";
import {
  FileProviderCredentialPersistence,
  SafeStorageCredentialBackend,
} from "./SafeStorageCredentialBackend.js";
import { ProviderCredentialStore } from "./ProviderCredentialStore.js";
import { NativeWindowsCredentialBackend } from "./WindowsCredentialBackend.js";

export function createElectronProviderCredentialStore(userDataPath: string): ProviderCredentialStore {
  return new ProviderCredentialStore(
    new SafeStorageCredentialBackend(new FileProviderCredentialPersistence(join(userDataPath, "provider-credentials")),
      new ElectronSafeStorageCredentialCipher()),
    process.platform === "win32" ? new NativeWindowsCredentialBackend() : undefined,
  );
}

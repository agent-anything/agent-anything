import { join } from "node:path";
import { ElectronSafeStorageCredentialCipher } from "./ElectronSafeStorageCredentialCipher.js";
import {
  FileProviderCredentialPersistence,
  ProviderCredentialStore,
} from "./ProviderCredentialStore.js";

export function createElectronProviderCredentialStore(userDataPath: string): ProviderCredentialStore {
  return new ProviderCredentialStore(
    new FileProviderCredentialPersistence(join(userDataPath, "provider-credentials")),
    new ElectronSafeStorageCredentialCipher(),
  );
}

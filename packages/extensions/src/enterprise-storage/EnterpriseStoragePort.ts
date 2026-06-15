import type {
  EnterpriseStoredArtifact,
  StoreEnterpriseArtifactInput,
} from "./EnterpriseStoredArtifact.js";

export interface EnterpriseStoragePort {
  storeArtifact(
    input: StoreEnterpriseArtifactInput,
  ): Promise<EnterpriseStoredArtifact>;
}

import type { EvidencePersistencePort } from "@agent-anything/context/persistence";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as enterpriseStorageApi from "./index.js";
import {
  EnterpriseEvidencePersistenceAdapter,
  type EnterpriseEvidencePersistenceClient,
} from "./index.js";

describe("Enterprise Storage public API", () => {
  it("exports only owner-specific adapter values", () => {
    expect(Object.keys(enterpriseStorageApi).sort()).toEqual([
      "EnterpriseEvidencePersistenceAdapter",
      "createEnterpriseEvidencePersistenceAdapter",
    ]);
    expect(enterpriseStorageApi).not.toHaveProperty("EnterpriseStoragePort");
    expect(enterpriseStorageApi).not.toHaveProperty("storeArtifact");
  });

  it("implements the Context-owned Evidence persistence Contract", () => {
    expectTypeOf<EnterpriseEvidencePersistenceAdapter>()
      .toMatchTypeOf<EvidencePersistencePort>();
    expectTypeOf<EnterpriseEvidencePersistenceClient>().toBeObject();
  });
});

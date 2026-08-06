import type { EvidencePersistencePort } from "@agent-anything/context/persistence";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as enterpriseEvidenceApi from "./index.js";
import {
  EnterpriseEvidencePersistenceAdapter,
  type EnterpriseEvidencePersistenceClient,
} from "./index.js";

describe("Enterprise Evidence persistence public API", () => {
  it("exports only owner-specific adapter values", () => {
    expect(Object.keys(enterpriseEvidenceApi).sort()).toEqual([
      "EnterpriseEvidencePersistenceAdapter",
      "createEnterpriseEvidencePersistenceAdapter",
    ]);
    expect(enterpriseEvidenceApi).not.toHaveProperty("EnterpriseStoragePort");
    expect(enterpriseEvidenceApi).not.toHaveProperty("storeArtifact");
  });

  it("implements the Context-owned Evidence persistence Contract", () => {
    expectTypeOf<EnterpriseEvidencePersistenceAdapter>()
      .toMatchTypeOf<EvidencePersistencePort>();
    expectTypeOf<EnterpriseEvidencePersistenceClient>().toBeObject();
  });
});

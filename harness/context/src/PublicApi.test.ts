import { describe, expect, expectTypeOf, it } from "vitest";
import * as activeContextApi from "./active-context/index.js";
import * as contractApi from "./contract/index.js";
import * as contributionApi from "./contribution/index.js";
import * as evidenceApi from "./evidence/index.js";
import * as persistenceApi from "./persistence/index.js";
import * as projectionApi from "./projection/index.js";
import * as materialApi from "./material/index.js";
import * as preparationApi from "./preparation/index.js";
import * as custodyApi from "./custody/index.js";
import * as representationApi from "./representation/index.js";
import * as selectionApi from "./selection/index.js";
import type { ActiveContext } from "./active-context/index.js";
import type { ContextContribution } from "./contribution/index.js";
import type { ContextProjection } from "./projection/index.js";
import type { Evidence } from "./evidence/index.js";
import type { EvidencePersistencePort } from "./persistence/index.js";
import type { ProjectionManifest } from "./projection/index.js";

describe("Context public API", () => {
  it("exposes only focused Context component subpaths", () => {
    expect(Object.keys(contractApi)).toEqual(["ContextContractError"]);
    expect(Object.keys(contributionApi).sort()).toEqual([
      "isContextDisclosureAtLeastAsRestrictive",
      "measureContextPayload",
      "snapshotContextContribution",
      "snapshotContextContributionRef",
      "snapshotContextDisclosure",
      "snapshotContextPreservation",
    ]);
    expect(Object.keys(activeContextApi).sort()).toEqual([
      "admitContextContribution",
      "applyContextTransition",
      "createEmptyActiveContext",
      "deriveContextRefreshOperation",
      "snapshotActiveContext",
      "snapshotActiveContextRef",
      "snapshotContextAdmissionProfile",
      "snapshotContextRefreshProposal",
      "snapshotContextTransition",
    ]);
    expect(Object.keys(projectionApi).sort()).toEqual([
      "createSafeProjectionManifest",
      "projectActiveContext",
      "snapshotContextProjection",
      "snapshotContextProjectionRequest",
      "snapshotProjectionManifest",
      "snapshotSafeProjectionManifest",
    ]);
    expect(Object.keys(evidenceApi).sort()).toEqual([
      "EvidenceBuilder",
      "settleEvidenceContribution",
      "snapshotEvidenceContribution",
    ]);
    expect(Object.keys(persistenceApi)).toEqual([]);
    expect(Object.keys(custodyApi).sort()).toEqual(["CustodyMaterialAccess", "MaterialCustodyError", "containsMaterialRange", "custodyCount", "custodyToken", "sameMaterialVersion"]);
    expect(Object.keys(representationApi)).toEqual([]);
    expect(Object.keys(selectionApi)).toEqual([]);
    expect(Object.keys(preparationApi).sort()).toEqual(["InMemoryContextPreparationStore", "contextPreparationDigest", "validateContextPreparationIntent"]);
    expect(Object.keys(materialApi).sort()).toEqual([
      "CONTEXT_MATERIAL_LIMITS", "ContextMaterialError", "contextMaterialDigest",
      "readContextMaterialText", "snapshotContextMaterialRef", "snapshotContextMaterialRefs",
    ]);
  });

  it("retains generic state and projection types on the Context subpath", () => {
    expectTypeOf<ContextProjection>().toBeObject();
    expectTypeOf<Evidence>().toBeObject();
    expectTypeOf<EvidencePersistencePort>().toBeObject();
    expectTypeOf<ContextContribution>().toBeObject();
    expectTypeOf<ActiveContext>().toBeObject();
    expectTypeOf<ProjectionManifest>().toBeObject();
  });
});

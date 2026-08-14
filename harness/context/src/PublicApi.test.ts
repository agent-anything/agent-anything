import { describe, expect, expectTypeOf, it } from "vitest";
import * as activeContextApi from "./active-context/index.js";
import * as contractApi from "./contract/index.js";
import * as contributionApi from "./contribution/index.js";
import * as contextApi from "./context/index.js";
import * as evidenceApi from "./evidence/index.js";
import * as persistenceApi from "./persistence/index.js";
import * as projectionApi from "./projection/index.js";
import type { ActiveContext } from "./active-context/index.js";
import type { ContextContribution } from "./contribution/index.js";
import type {
  Context,
  ContextProjection,
  ContextProjectorPort,
} from "./context/index.js";
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
    ]);
    expect(Object.keys(activeContextApi).sort()).toEqual([
      "createEmptyActiveContext",
      "snapshotActiveContext",
      "snapshotActiveContextRef",
      "snapshotContextTransition",
    ]);
    expect(Object.keys(projectionApi).sort()).toEqual([
      "snapshotContextProjection",
      "snapshotContextProjectionRequest",
      "snapshotProjectionManifest",
    ]);
    expect(Object.keys(contextApi).sort()).toEqual([
      "ContextProjectionError",
      "applyContextUpdate",
      "createInitialContext",
      "snapshotContextProjection",
      "snapshotContextProjectionRequest",
    ]);
    expect(Object.keys(evidenceApi).sort()).toEqual([
      "EvidenceBuilder",
      "settleEvidenceContribution",
      "snapshotEvidenceContribution",
    ]);
    expect(Object.keys(persistenceApi)).toEqual([]);
  });

  it("retains generic state and projection types on the Context subpath", () => {
    expectTypeOf<Context>().toBeObject();
    expectTypeOf<ContextProjection>().toBeObject();
    expectTypeOf<ContextProjectorPort>().toBeObject();
    expectTypeOf<Evidence>().toBeObject();
    expectTypeOf<EvidencePersistencePort>().toBeObject();
    expectTypeOf<ContextContribution>().toBeObject();
    expectTypeOf<ActiveContext>().toBeObject();
    expectTypeOf<ProjectionManifest>().toBeObject();
  });
});

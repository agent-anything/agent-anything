import { describe, expect, expectTypeOf, it } from "vitest";
import * as rootApi from "./index.js";
import * as contextApi from "./context/index.js";
import * as evidenceApi from "./evidence/index.js";
import * as observationApi from "./observation/index.js";
import * as persistenceApi from "./persistence/index.js";
import type { ContextProjection } from "./context/index.js";
import type { Evidence } from "./evidence/index.js";
import type { Observation } from "./observation/index.js";
import type { EvidencePersistencePort } from "./persistence/index.js";

describe("Context public API", () => {
  it("exposes focused Context component subpaths", () => {
    expect(Object.keys(rootApi).sort()).toEqual([
      "EvidenceBuilder",
      "applyContextUpdate",
      "classifyToolResult",
      "createInitialContext",
      "projectContext",
      "settleToolResultEvidence",
    ]);
    expect(Object.keys(contextApi).sort()).toEqual([
      "applyContextUpdate",
      "createInitialContext",
      "projectContext",
    ]);
    expect(Object.keys(evidenceApi).sort()).toEqual([
      "EvidenceBuilder",
      "classifyToolResult",
      "settleToolResultEvidence",
    ]);
    expect(Object.keys(observationApi)).toEqual([]);
    expect(Object.keys(persistenceApi)).toEqual([]);
  });

  it("retains semantic types on their owning subpaths", () => {
    expectTypeOf<ContextProjection>().toBeObject();
    expectTypeOf<Evidence>().toBeObject();
    expectTypeOf<Observation>().toBeObject();
    expectTypeOf<EvidencePersistencePort>().toBeObject();
  });
});

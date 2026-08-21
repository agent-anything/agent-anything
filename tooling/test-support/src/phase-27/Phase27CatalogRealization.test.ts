import { describe, expect, it } from "vitest";
import {
  findPhase27CatalogRecord,
  PHASE27_BINDING_CONFORMANCE,
  PHASE27_CATALOG_REALIZATION_REGISTRY,
  PHASE27_SCENARIO_CONFORMANCE,
} from "./Phase27CatalogRealization.js";

const EXPECTED_RECORD_IDS = [
  ...ids("D", 13),
  ...ids("C", 4),
  ...ids("A", 2),
  ...ids("I", 6),
  ...ids("U", 5),
  ...ids("X", 3),
  ...ids("V", 3),
  ...ids("E", 3),
  ...ids("S", 7),
  ...ids("M", 6),
];

describe("Phase27 catalog realization registry", () => {
  it("assigns exactly one immutable truthful disposition to all fifty-two records", () => {
    expect(PHASE27_CATALOG_REALIZATION_REGISTRY).toHaveLength(52);
    expect(PHASE27_CATALOG_REALIZATION_REGISTRY.map(({ recordId }) => recordId).sort())
      .toEqual([...EXPECTED_RECORD_IDS].sort());
    expect(new Set(PHASE27_CATALOG_REALIZATION_REGISTRY.map(({ intendedOperationRevision }) =>
      intendedOperationRevision)).size).toBe(52);
    expect(Object.isFrozen(PHASE27_CATALOG_REALIZATION_REGISTRY)).toBe(true);
    expect(PHASE27_CATALOG_REALIZATION_REGISTRY.every((record) =>
      Object.isFrozen(record) && Object.isFrozen(record.disposition))).toBe(true);
  });

  it("uses registered only for current real composition and typed unavailable otherwise", () => {
    const registered = PHASE27_CATALOG_REALIZATION_REGISTRY.filter(({ disposition }) =>
      disposition.status === "registered");
    const unavailable = PHASE27_CATALOG_REALIZATION_REGISTRY.filter(({ disposition }) =>
      disposition.status === "unavailable");

    expect(registered.map(({ recordId }) => recordId)).toEqual([
      "P24-CAP-D001",
      "P24-CAP-D002",
      "P24-CAP-D003",
      "P24-CAP-D004",
      "P24-CAP-D005",
      "P24-CAP-I002",
      "P24-CAP-I004",
      "P24-CAP-I005",
      "P24-CAP-I006",
      "P24-CAP-V001",
      "P24-CAP-V002",
      "P24-CAP-V003",
      "P24-CAP-E001",
      "P24-CAP-E002",
      "P24-CAP-E003",
    ]);
    expect(unavailable).toHaveLength(37);
    for (const record of registered) {
      if (record.disposition.status !== "registered") continue;
      expect(record.disposition.registrationRefs.length).toBeGreaterThan(0);
      expect(record.disposition.resolverRefs.length).toBeGreaterThan(0);
    }
    for (const record of unavailable) {
      if (record.disposition.status !== "unavailable") continue;
      expect(record.disposition.intendedOwner).toBe(record.semanticOwner);
      expect(record.disposition.assignedPhase).toBe(record.assignedRealizationPhase);
      expect(record.disposition.reasonCode).toMatch(/^[a-z0-9_]+$/);
      expect("registrationRefs" in record.disposition).toBe(false);
      expect("resolverRefs" in record.disposition).toBe(false);
    }
  });

  it("does not infer Repository-native inspection from generic file operations", () => {
    expect(findPhase27CatalogRecord("P24-CAP-D008")).toMatchObject({
      intendedOperationRevision: "code.repository.inspect@1",
      assignedRealizationPhase: "Phase33",
      disposition: {
        status: "unavailable",
        reasonCode: "repository_inspection_not_composed",
      },
    });
  });

  it("covers all five binding forms and all twelve accepted scenarios", () => {
    expect(PHASE27_BINDING_CONFORMANCE.map(({ bindingFamily }) => bindingFamily).sort())
      .toEqual(["composite", "descendant_agent", "direct", "hosted", "internal"]);
    expect(PHASE27_SCENARIO_CONFORMANCE.map(({ scenarioId }) => scenarioId)).toEqual(
      Array.from({ length: 12 }, (_, index) => `P23-S-${String(index + 1).padStart(3, "0")}`),
    );
    const catalogIds = new Set(PHASE27_CATALOG_REALIZATION_REGISTRY.map(({ recordId }) => recordId));
    for (const scenario of PHASE27_SCENARIO_CONFORMANCE) {
      expect(scenario.catalogRecordIds.length).toBeGreaterThan(0);
      expect(scenario.evidence.length).toBeGreaterThan(0);
      expect(scenario.catalogRecordIds.every((recordId) => catalogIds.has(recordId))).toBe(true);
    }
    expect(PHASE27_CATALOG_REALIZATION_REGISTRY.every(({ scenarioIds, routeEvidence }) =>
      scenarioIds.length > 0 && routeEvidence.length > 0)).toBe(true);
  });
});

function ids(prefix: string, count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `P24-CAP-${prefix}${String(index + 1).padStart(3, "0")}`,
  );
}

import { expect, it } from "vitest";
import { InspectionStorageUsage } from "./InspectionStorageUsage.js";

it("reconciles other writers/retirement without losing or duplicating local mutations", () => {
  const usage = new InspectionStorageUsage({ bytes: 100, visited: 1, datasetFiles: [] });
  usage.physicalFileChanged("content/a", 10);
  usage.beginReconciliation();
  usage.physicalFileChanged("content/a", 20);
  usage.physicalFileChanged("content/new", 30);
  usage.physicalFileChanged("staging/partial", 4);
  usage.reconcile({ bytes: 210, visited: 3, datasetFiles: [["content/a", 10]] });
  expect(usage.datasetBytes).toBe(54);
  expect(usage.sourceBytes).toBe(254);
  usage.beginReconciliation();
  usage.physicalFileChanged("staging/partial", 0);
  // The scan already observed the newly published file; the overlay is a
  // replacement by pathname, not a second addition of its bytes.
  usage.physicalFileChanged("content/new", 30);
  usage.reconcile({ bytes: 104, visited: 4, datasetFiles: [["content/a", 20], ["content/new", 30], ["staging/partial", 4]] });
  expect(usage.datasetBytes).toBe(50);
  expect(usage.sourceBytes).toBe(100);
});

it("counts file replacements, checkpoint shrinkage and quota without cumulative estimates", () => {
  const usage = new InspectionStorageUsage({ bytes: 100, visited: 1, datasetFiles: [] });
  usage.physicalFileChanged("inspection.sqlite-wal", 1000);
  usage.physicalFileChanged("inspection.sqlite-wal", 1000);
  expect(usage.sourceBytes).toBe(1100);
  usage.physicalFileChanged("inspection.sqlite-wal", 0);
  expect(usage.sourceBytes).toBe(100);
  expect(() => usage.check(2048 * 1024 * 1024)).toThrow("inspection_storage_budget_exhausted");
  usage.physicalFileChanged("content/large", 512 * 1024 * 1024);
  expect(() => usage.check()).toThrow("inspection_storage_budget_exhausted");
});

it("rejects overlapping reconciliation", () => {
  const usage = new InspectionStorageUsage({ bytes: 0, visited: 0, datasetFiles: [] });
  usage.beginReconciliation();
  expect(() => usage.beginReconciliation()).toThrow("inspection_storage_scan_overlap");
});

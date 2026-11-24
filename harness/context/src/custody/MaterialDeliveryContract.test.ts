import { describe, expect, it } from "vitest";
import { snapshotMaterialDeliveryDisposition, snapshotMaterialDeliveryObligation, type MaterialDeliveryObligation } from "./MaterialDeliveryContract.js";
const ref = (id: string) => ({ id, revision: "1" });
const obligation: MaterialDeliveryObligation = { ref: ref("delivery"), contract: { ref: ref("host-receipt"), owner: "host", confirmation: "accepted-file-custody" },
  recipient: { runId: "root", recipient: "host", purpose: "export" }, range: { materialId: "material", version: "original", start: 0, end: 100, coordinate: "bytes" }, holdId: "host-hold" };

describe("Recipient-specific material disposition contracts", () => {
  it("allows Host-only fulfillment without any model-input receipt or Run ending", () => {
    const result = snapshotMaterialDeliveryDisposition(obligation, { kind: "fulfilled", obligation: obligation.ref, contract: obligation.contract.ref, receipt: ref("host-accepted") });
    expect(result).toEqual({ kind: "fulfilled", obligation: ref("delivery"), contract: ref("host-receipt"), receipt: ref("host-accepted") });
    expect("releaseAll" in result).toBe(false);
    expect(Object.isFrozen(snapshotMaterialDeliveryObligation(obligation).recipient)).toBe(true);
  });
  it("requires withdrawal authority and an in-flight resolution, not absence of a reply", () => {
    expect(() => snapshotMaterialDeliveryDisposition(obligation, { kind: "non_delivery", obligation: obligation.ref, contract: obligation.contract.ref,
      authorization: ref("withdrawal"), inFlightResolution: ref("confirmed-resolution") })).not.toThrow();
    expect(() => snapshotMaterialDeliveryDisposition(obligation, { kind: "non_delivery", obligation: obligation.ref, contract: obligation.contract.ref,
      authorization: ref("withdrawal"), inFlightResolution: null! })).toThrow();
  });
  it("allows partial responsibility transfer without discharging the remainder or other holds", () => {
    const range = { ...obligation.range, end: 40 };
    const successor = { ...obligation, ref: ref("successor-delivery"), recipient: { ...obligation.recipient, recipient: "other-host" }, range, holdId: "successor-hold" };
    const disposition = { kind: "transferred" as const, obligation: obligation.ref, contract: obligation.contract.ref, acceptance: ref("receiver-accepted"), range, successor };
    expect(snapshotMaterialDeliveryDisposition(obligation, disposition)).toEqual(disposition);
    expect(obligation.range.end).toBe(100);
    expect(() => snapshotMaterialDeliveryDisposition(obligation, { ...disposition, acceptance: null! })).toThrow();
    expect(() => snapshotMaterialDeliveryDisposition(obligation, { ...disposition, range: { ...range, end: 101 } })).toThrow("material_delivery_transfer_invalid");
    expect(() => snapshotMaterialDeliveryDisposition(obligation, { ...disposition, successor: obligation })).toThrow("material_delivery_transfer_invalid");
  });
  it("does not accept another recipient's contract revision or a hidden delete instruction", () => {
    const value = { kind: "fulfilled" as const, obligation: obligation.ref, contract: ref("another-contract"), receipt: ref("receipt") };
    expect(() => snapshotMaterialDeliveryDisposition(obligation, value)).toThrow("material_delivery_basis_mismatch");
    expect(() => snapshotMaterialDeliveryDisposition(obligation, { ...value, contract: obligation.contract.ref, delete: true } as typeof value)).toThrow();
  });
});

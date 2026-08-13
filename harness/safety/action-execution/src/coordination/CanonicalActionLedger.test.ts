import { describe, expect, it } from "vitest";
import { CanonicalActionCommitError, CanonicalActionLedger } from "./CanonicalActionLedger.js";

describe("CanonicalActionLedger", () => {
  it("uses optimistic revisions for transitions", () => {
    const ledger = new CanonicalActionLedger({ id: "action-1" }, null);
    expect(ledger.commit({ expectedRevision: 0, kind: "begin_preparation" })).toMatchObject({ revision: 1, lifecycle: "preparing" });
    expect(() => ledger.commit({ expectedRevision: 0, kind: "begin_preparation" })).toThrow(CanonicalActionCommitError);
  });

  it("rejects a subject belonging to another Action", () => {
    const ledger = new CanonicalActionLedger({ id: "action-1" }, null);
    ledger.commit({ expectedRevision: 0, kind: "begin_preparation" });
    expect(() => ledger.commit({
      expectedRevision: 1,
      kind: "record_subject",
      subject: { ref: { action: { id: "action-2" }, revision: 1 } } as never,
    })).toThrow(CanonicalActionCommitError);
  });
});

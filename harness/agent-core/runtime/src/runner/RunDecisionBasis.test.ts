import {it, expect} from "vitest";
import {RunDecisionBasis} from "./RunDecisionBasis.js";
import {RunStateWriter} from "./RunStateWriter.js";
import type {RunState} from "../run/index.js";

it("preserves captured decisions for auxiliary technical commits but not business changes", () => {
  const basis = new RunDecisionBasis(); basis.capture("new-turn", 10);
  const bookkeeping = {kind: "auxiliary" as const, invocationId: "old-background"};
  expect(basis.snapshot(11, bookkeeping)).toEqual([["new-turn", 10]]);
  basis.committed(11, bookkeeping); expect(basis.revision("new-turn", 11)).toBe(10);
  basis.committed(12, null); expect(basis.revision("new-turn", 12)).toBe(12);
});
it("rejects a business state patch labeled as auxiliary bookkeeping", async () => {
  const writer = new RunStateWriter({run: {id: "r"}, revision: 0, status: "running", items: []} as unknown as RunState,
    () => new Date().toISOString(), () => "id", () => {});
  await expect(writer.commitState(() => ({status: "waiting"}), {kind: "auxiliary", invocationId: "bg"}))
    .rejects.toThrow("cannot change business state");
  expect(writer.getSnapshot().revision).toBe(0);
});

import { describe, expect, it } from "vitest";
import { DEEPSEEK_CHAT_COMPLETIONS, OLLAMA_CHAT, OPENAI_RESPONSES, type NativeModelSourceRef } from "@agent-anything/model-interaction/protocol";
import {
  aggregateNativeWork, applyNativeAccountingCommand, calculateNativeCost, createNativeAccountingState,
  decodeNativeWorkIndexEntryMetadata, encodeNativeWorkIndexEntryMetadata, nativeAccountingWorkSnapshot,
  nativeWorkForSubmission, nativeWorkIndexEntry, projectNativeCacheEvidence, projectNativeUsage, restoreNativeAccountingState,
  summarizeNativeCache, validateResponsesCacheSettings,
  type NativeAccountingCommand, type NativeAccountingState, type NativePriceContext, type NativeRateBasis,
  type NativeUsageObservation, type NativeUsageProfile, type NativeWorkSubmission,
} from "./index.js";
import { key } from "./AccountingValue.js";
import { assertNativeAccountingWorkProgress, nativeAccountingWorkMergePlan } from "./NativeAccountingMerge.js";

const basis = { id: "fixture-contract", revision: "1" };
const at = "2026-11-13T00:00:00.000Z";
const profile: NativeUsageProfile = { kind: "openai.responses", revision: "1", cacheWrites: "aggregate", basis };
const legacy: NativeUsageProfile = { ...profile, cacheWrites: "not_applicable" };
const readField = "input_tokens_details.cached_tokens";
const writeField = "input_tokens_details.cache_write_tokens";
const usage = (input = 10000, output = 500, cached = 4000, writes = 3000) => ({ input_tokens: input, output_tokens: output,
  total_tokens: input + output, input_tokens_details: { cached_tokens: cached, cache_write_tokens: writes }, output_tokens_details: { reasoning_tokens: 20 } });
function submission(id = "s1", extra: Partial<NativeWorkSubmission> = {}): NativeWorkSubmission {
  return { id, protocol: OPENAI_RESPONSES, scope: { runId: "parent", activityId: "a1", recipientId: "r1", purpose: { id: "task", revision: "1" }, compositionDigest: `sha256:${"a".repeat(64)}` },
    endpoint: "https://example.test", account: "test-project", operation: "generation", submittedAt: at, model: "fixture-model",
    requestedTier: "priority", reportedTier: null, region: "region-one", modality: "text", reconciliationOwner: "worker", beneficiaries: [], stage: null, ...extra };
}
function source(id: string, s = submission(), remote: string | null = null): NativeModelSourceRef {
  return { protocol: s.protocol, scope: s.scope, interpretation: basis, operationId: id, record: { id, revision: "1" },
    position: { format: "json-pointer", value: "/usage" }, nativeIdentity: remote ? { kind: "response", id: remote } : null };
}
function registered(s = submission(), state = createNativeAccountingState()) {
  return applyNativeAccountingCommand(state, { id: `register-${s.id}`, kind: "register", submission: s });
}
function observe(state: NativeAccountingState, id = "obs1", value: unknown = usage(), extra: Partial<NativeUsageObservation> = {}, s = submission()) {
  return applyNativeAccountingCommand(state, { id: `observe-${id}`, kind: "observe", observation: { id, submissionId: s.id,
    source: source(id, s), receivedAt: at, channel: "stream", finality: "terminal", authority: "provider", revisionDomain: "response", cumulativeRevision: null,
    profile, usage: value, ...extra } });
}
function bound(state: NativeAccountingState, id: string, remote = "resp1", s = submission(id)) {
  return applyNativeAccountingCommand(state, { id: `bind-${id}`, kind: "bind_remote", submissionId: id,
    remote: { kind: "response", id: remote }, evidence: source(`bind-source-${id}`, s, remote) });
}
function reserve(state: NativeAccountingState, id = "reservation", submissionId = "s1") {
  return applyNativeAccountingCommand(state, { id: `reserve-${id}`, kind: "reserve", reservation: { id, submissionId, resource: "remote-budget",
    amount: "0.1", unit: "USD", guarantee: "estimate", admissionBasis: basis } });
}
const exact = (value: string) => ({ match: "exact" as const, value });
function rate(extra: Partial<NativeRateBasis> = {}): NativeRateBasis {
  return { ref: { id: "synthetic-price", revision: "1" }, source: "synthetic test only", kind: "synthetic", protocol: OPENAI_RESPONSES,
    effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveUntil: null, endpoint: exact("https://example.test"), account: exact("test-project"),
    model: exact("fixture-model"), reportedTier: exact("default"), region: exact("region-one"), modality: exact("text"), operation: "generation",
    inputBand: null, currency: "USD", rates: [
      { component: "input_tokens.ordinary", unit: "tokens", amount: "2", perUnits: "1000000" },
      { component: readField, unit: "tokens", amount: "0.2", perUnits: "1000000" },
      { component: writeField, unit: "tokens", amount: "3", perUnits: "1000000" },
      { component: "output_tokens", unit: "tokens", amount: "8", perUnits: "1000000" },
    ], ...extra };
}
const context: NativePriceContext = { protocol: OPENAI_RESPONSES, endpoint: "https://example.test", account: "test-project", operation: "generation",
  occurredAt: at, model: "fixture-model", reportedTier: "default", region: "region-one", modality: "text", basis };
function cost(state: NativeAccountingState, extra: Partial<Parameters<typeof calculateNativeCost>[0]> = {}) {
  return calculateNativeCost({ work: nativeWorkForSubmission(state, "s1"), calculation: { id: "calculation", revision: "1" }, decisionAt: at,
    context, rates: [rate()], additional: [], chargeCoverage: { state: "complete", basis }, ...extra });
}

describe("protocol-native accounting quantities", () => {
  it("keeps raw fields and disjoint Responses components; reasoning and totals are not extra charges", () => {
    const native = usage(), result = projectNativeUsage({ protocol: OPENAI_RESPONSES, profile, usage: native });
    expect(result.raw).toEqual(native);
    expect(result.components.map(c => [c.id, c.quantity])).toEqual([
      ["input_tokens.ordinary", { state: "known", value: 3000 }], [readField, { state: "known", value: 4000 }],
      [writeField, { state: "known", value: 3000 }], ["output_tokens", { state: "known", value: 500 }],
    ]);
  });
  it("distinguishes missing, unavailable, explicit zero and applicable legacy absence", () => {
    const missing = projectNativeUsage({ protocol: OPENAI_RESPONSES, profile, usage: {} });
    expect(missing.fields.input_tokens?.state).toBe("missing");
    const unavailable = projectNativeUsage({ protocol: OPENAI_RESPONSES, profile, usage: null });
    expect(unavailable.fields.input_tokens?.state).toBe("unavailable");
    const zero = projectNativeUsage({ protocol: OPENAI_RESPONSES, profile: legacy, usage: {
      input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0 } } });
    expect(zero.fields[writeField]?.state).toBe("not_applicable");
    expect(zero.components[0]?.quantity).toEqual({ state: "known", value: 0 });
    expect(missing.components[0]?.quantity.state).toBe("missing");
  });
  it.each([-1, 0.1, "12", Number.MAX_SAFE_INTEGER + 1])("retains invalid native usage without plausible clamping: %s", n => {
    const result = projectNativeUsage({ protocol: OPENAI_RESPONSES, profile, usage: { ...usage(), input_tokens: n } });
    expect(result.fields.input_tokens?.state).toBe("invalid");
  });
  it("rejects inconsistent totals, overlapping subsets and write lifetime arithmetic", () => {
    for (const native of [usage(10, 20, 8, 7), { ...usage(), total_tokens: 1 }, {
      ...usage(), input_tokens_details: { cached_tokens: 4000, cache_write_tokens: 3000, cache_write_tokens_details: { ttl_30m_tokens: 2000, ttl_12h_tokens: 2000 } } }]) {
      expect(projectNativeUsage({ protocol: OPENAI_RESPONSES, profile, usage: native }).issues.length).toBeGreaterThan(0);
    }
  });
  it("never adds lifetime details to aggregate writes", () => {
    const result = projectNativeUsage({ protocol: OPENAI_RESPONSES, profile: { ...profile, cacheWrites: "lifetimes" }, usage: {
      ...usage(), input_tokens_details: { cached_tokens: 4000, cache_write_tokens: 3000, cache_write_tokens_details: { ttl_30m_tokens: 1000, ttl_12h_tokens: 2000 } } } });
    expect(result.components.map(c => c.id)).not.toContain(writeField);
    expect(result.components).toHaveLength(5);
  });
  it("preserves DeepSeek and Ollama field names, units and unknown cache coverage", () => {
    const deep = projectNativeUsage({ protocol: DEEPSEEK_CHAT_COMPLETIONS, profile: { kind: "deepseek.chat-completions", revision: "1", basis },
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13, prompt_cache_hit_tokens: 4, prompt_cache_miss_tokens: 6 } });
    expect(deep.components.map(c => c.id)).toEqual(["prompt_cache_miss_tokens", "prompt_cache_hit_tokens", "completion_tokens"]);
    const ollama = projectNativeUsage({ protocol: OLLAMA_CHAT, profile: { kind: "ollama.chat", revision: "1", basis },
      usage: { prompt_eval_count: 10, eval_count: 3, total_duration: 50000000 } });
    expect(ollama.fields.prompt_eval_cached_count?.state).toBe("missing");
    expect(ollama.units.total_duration).toBe("nanoseconds");
    expect(ollama.fields).not.toHaveProperty("total_tokens");
  });
});

describe("physical work and durable pure reconciliation", () => {
  it("counts stream, GET and restarted retrieval as one contribution without changing its revision", () => {
    let state = bound(registered(), "s1");
    state = observe(state, "stream", usage(), { source: source("stream", submission(), "resp1") });
    const original = nativeWorkForSubmission(state, "s1").contribution.revision;
    state = restoreNativeAccountingState(JSON.parse(JSON.stringify(state)));
    state = observe(state, "get", usage(), { channel: "get", source: source("get", submission(), "resp1") });
    const work = nativeWorkForSubmission(state, "s1");
    expect(work.contribution.revision).toBe(original);
    expect(work.contribution.observationIds).toEqual(["get", "stream"]);
    expect(Object.values(state.works)).toHaveLength(1);
    expect(nativeWorkIndexEntry(state, "s1").inputTokens).toBe(10000);
  });
  it("replaces ordered partial cumulative snapshots, ignores late older partials and retains terminal conflicts", () => {
    let state = observe(registered(), "partial2", usage(100, 40, 0, 0), { finality: "partial", cumulativeRevision: 2 });
    state = observe(state, "partial1", usage(100, 20, 0, 0), { finality: "partial", cumulativeRevision: 1 });
    expect(nativeWorkIndexEntry(state, "s1").outputTokens).toBe(40);
    state = observe(state, "terminal", usage(100, 60, 0, 0));
    expect(nativeWorkIndexEntry(state, "s1").outputTokens).toBe(60);
    state = observe(state, "terminal-conflict", usage(100, 80, 0, 0), { channel: "get" });
    expect(nativeWorkIndexEntry(state, "s1")).toMatchObject({ usageState: "conflicting", outputState: "conflicting", outputTokens: null });
    expect(restoreNativeAccountingState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });
  it("makes cumulative regression explicit, including when observations arrive out of order", () => {
    let state = observe(registered(), "later", usage(100, 20, 0, 0), { finality: "partial", cumulativeRevision: 2 });
    state = observe(state, "earlier", usage(100, 40, 0, 0), { finality: "partial", cumulativeRevision: 1 });
    expect(nativeWorkForSubmission(state, "s1").contribution.issues).toContain("cumulative_regression:output_tokens");
    expect(nativeWorkIndexEntry(state, "s1").outputTokens).toBeNull();
  });
  it("merges an unknown submission only with retained scoped identity evidence; replacement stays distinct", () => {
    let state = registered();
    state = registered(submission("known"), state); state = registered(submission("replacement"), state);
    state = bound(state, "known");
    state = observe(state, "known-usage", usage(), { source: source("known-usage", submission("known"), "resp1") }, submission("known"));
    state = bound(state, "s1");
    expect(Object.values(state.works)).toHaveLength(2);
    expect(nativeWorkForSubmission(state, "s1").id).toBe(nativeWorkForSubmission(state, "known").id);
    expect(nativeWorkForSubmission(state, "replacement").exposure).toBe("unresolved");
    const bad: NativeAccountingCommand = { id: "bad-bind", kind: "bind_remote", submissionId: "s1", remote: { kind: "response", id: "resp1" }, evidence: source("missing-identity") };
    expect(() => applyNativeAccountingCommand(registered(), bad)).toThrow("identity_evidence");
  });
  it("does not deduplicate identical text/work across accounts, operation families or submissions", () => {
    let state = bound(registered(), "s1");
    for (const s of [submission("account", { account: "another" }), submission("compact", { operation: "compact" })]) {
      state = registered(s, state); state = bound(state, s.id, "resp1", s);
    }
    expect(Object.values(state.works)).toHaveLength(3);
  });
  it("retains usage for invalid/refused/unused results without accepting any task output", () => {
    const state = observe(registered());
    expect(nativeWorkIndexEntry(state, "s1").usageState).toBe("observed");
    expect(state).not.toHaveProperty("accepted"); expect(state).not.toHaveProperty("effects");
  });
  it("retains reservations on local release/handoff/restart, then atomically settles the original identity once", () => {
    let state = reserve(registered());
    state = applyNativeAccountingCommand(state, { id: "release", kind: "release_local", submissionId: "s1", basis });
    state = applyNativeAccountingCommand(state, { id: "handoff", kind: "handoff", submissionId: "s1", expectedOwner: "worker", nextOwner: "reconciler", basis });
    state = restoreNativeAccountingState(JSON.parse(JSON.stringify(state)));
    expect(nativeWorkIndexEntry(state, "s1")).toMatchObject({ localReleased: true, exposure: "unresolved", heldReservations: 1 });
    state = observe(state);
    const settle: NativeAccountingCommand = { id: "settle", kind: "settle", submissionId: "s1", owner: "reconciler", reservationIds: ["reservation"],
      contributionRevision: nativeWorkForSubmission(state, "s1").contribution.revision, basis };
    const before = state; state = applyNativeAccountingCommand(state, settle);
    expect(nativeWorkIndexEntry(before, "s1").heldReservations).toBe(1);
    expect(nativeWorkIndexEntry(state, "s1")).toMatchObject({ exposure: "reconciled", heldReservations: 0 });
    const recovered = restoreNativeAccountingState(JSON.parse(JSON.stringify(state)));
    expect(applyNativeAccountingCommand(recovered, settle)).toBe(recovered);
    expect(() => applyNativeAccountingCommand(state, { ...settle, id: "second-debit" })).toThrow("already_committed");
    state = observe(state, "late-conflict", usage(10000, 600));
    expect(nativeWorkForSubmission(state, "s1").exposure).toBe("unresolved");
    expect(nativeWorkForSubmission(state, "s1").settlement?.id).toBe("settle");
  });
  it("requires complete evidence or explicit owner disposition; unknown/partial does not settle", () => {
    let state = reserve(observe(registered(), "partial", usage(), { finality: "partial" }));
    const settle: NativeAccountingCommand = { id: "settle", kind: "settle", submissionId: "s1", owner: "worker", reservationIds: ["reservation"],
      contributionRevision: nativeWorkForSubmission(state, "s1").contribution.revision, basis };
    expect(() => applyNativeAccountingCommand(state, settle)).toThrow("incomplete");
    expect(() => applyNativeAccountingCommand(state, { id: "dispose", kind: "dispose", submissionId: "s1", owner: "worker", reservationIds: [], basis })).toThrow("disposition_incomplete");
    state = applyNativeAccountingCommand(state, { id: "dispose", kind: "dispose", submissionId: "s1", owner: "worker", reservationIds: ["reservation"], basis });
    expect(nativeWorkIndexEntry(state, "s1")).toMatchObject({ exposure: "owner_disposed", heldReservations: 0 });
  });
  it("rejects corrupted cold snapshots and restores independent per-work snapshots", () => {
    let state = observe(registered()); state = registered(submission("other"), state);
    const one = nativeAccountingWorkSnapshot(state, "s1");
    expect(Object.values(one.works)).toHaveLength(1);
    expect(restoreNativeAccountingState(JSON.parse(JSON.stringify(one)))).toEqual(one);
    const corrupt = JSON.parse(JSON.stringify(one)); corrupt.works[Object.keys(corrupt.works)[0]].exposure = "reconciled";
    expect(() => restoreNativeAccountingState(corrupt)).toThrow("integrity");
  });
  it("keeps repeated register/observation/reservation identities idempotent, without losing command conflict checks", () => {
    let state = reserve(observe(registered()));
    state = applyNativeAccountingCommand(state, { id: "register-again", kind: "register", submission: submission() });
    const firstObservation = Object.values(state.commands).find(value => value.command.kind === "observe")!.command;
    state = applyNativeAccountingCommand(state, { ...firstObservation, id: "observation-again" });
    const firstReserve = Object.values(state.commands).find(value => value.command.kind === "reserve")!.command;
    state = applyNativeAccountingCommand(state, { ...firstReserve, id: "reservation-again" });
    expect(Object.values(state.works)).toHaveLength(1);
    expect(nativeWorkForSubmission(state, "s1").observationCommands).toHaveLength(1);
    expect(nativeWorkIndexEntry(state, "s1").heldReservations).toBe(1);
    expect(() => applyNativeAccountingCommand(state, { id: "register-again", kind: "register", submission: submission("another") })).toThrow("command_identity_conflict");
    expect(() => applyNativeAccountingCommand(state, { id: "corrupt-register", kind: "register", submission: submission("s1", { account: "changed" }) })).toThrow("submission_identity_conflict");
    expect(() => observe(state, "obs1", usage(10000, 600))).toThrow("command_identity_conflict");
    expect(restoreNativeAccountingState(JSON.parse(JSON.stringify(state)))).toEqual(state);
    expect(Object.isFrozen(Object.values(state.commands)[0])).toBe(true);
  });
  it("records a late original outcome after cancellation without erasing an independent replacement", () => {
    let state = reserve(registered());
    state = applyNativeAccountingCommand(state, { id: "cancelled-locally", kind: "release_local", submissionId: "s1", basis });
    const replacement = submission("replacement");
    state = reserve(registered(replacement, state), "replacement-reservation", replacement.id);
    state = observe(state);
    const settle: NativeAccountingCommand = { id: "settle-original", kind: "settle", submissionId: "s1", owner: "worker",
      reservationIds: ["reservation"], contributionRevision: nativeWorkForSubmission(state, "s1").contribution.revision, basis };
    state = applyNativeAccountingCommand(state, settle);
    expect(nativeWorkIndexEntry(state, "s1")).toMatchObject({ localReleased: true, exposure: "reconciled", heldReservations: 0 });
    expect(nativeWorkIndexEntry(state, "replacement")).toMatchObject({ localReleased: false, exposure: "unresolved", heldReservations: 1 });
    expect(Object.values(restoreNativeAccountingState(JSON.parse(JSON.stringify(state))).works)).toHaveLength(2);
  });
  it("does not hide contradictions at an earlier cumulative revision behind a later partial", () => {
    let state = observe(registered(), "rev1a", usage(100, 20, 0, 0), { finality: "partial", cumulativeRevision: 1 });
    state = observe(state, "rev1b", usage(100, 30, 0, 0), { finality: "partial", cumulativeRevision: 1 });
    state = observe(state, "rev2", usage(100, 40, 0, 0), { finality: "partial", cumulativeRevision: 2 });
    expect(nativeWorkForSubmission(state, "s1").contribution.issues).toContain("cumulative_revision_conflict:output_tokens");
  });
  it("reconciles a late unknown alias to settled known work without a second debit or silently released reservation", () => {
    let state = reserve(registered());
    const known = submission("known", { beneficiaries: ["child"] });
    state = observe(bound(registered(known, state), known.id, "resp1", known), "known-observation", usage(),
      { source: source("known-observation", known, "resp1") }, known);
    state = applyNativeAccountingCommand(state, { id: "known-settled", kind: "settle", submissionId: known.id, owner: "worker", reservationIds: [],
      contributionRevision: nativeWorkForSubmission(state, known.id).contribution.revision, basis });
    state = bound(state, "s1");
    expect(Object.values(state.works)).toHaveLength(1);
    expect(nativeWorkIndexEntry(state, "s1")).toMatchObject({ exposure: "unresolved", heldReservations: 1, beneficiaries: ["child"] });
    expect(nativeWorkForSubmission(state, "s1").settlement?.id).toBe("known-settled");
    expect(restoreNativeAccountingState(JSON.parse(JSON.stringify(nativeAccountingWorkSnapshot(state, "s1"))))).toEqual(nativeAccountingWorkSnapshot(state, "s1"));
  });
  it("does not merge read overhead just because repeated GETs target the same response", () => {
    const first = submission("read-1", { operation: "read" }), second = submission("read-2", { operation: "read" });
    const state = registered(second, registered(first));
    expect(() => bound(state, first.id, "resp1", first)).toThrow("remote_work_identity_unsupported");
    expect(Object.values(state.works)).toHaveLength(2);
  });
});

describe("replay-derived durable merge plans", () => {
  it("discovers every vanished identity from replay, including unpublished aliases and duplicate registration", () => {
    let state = registered(submission("unrelated"), registered());
    const first = nativeWorkForSubmission(state, "s1").id;
    state = bound(registered(submission("second"), state), "second");
    state = registered(submission("third"), state);
    const third = nativeWorkForSubmission(state, "third").id;
    state = bound(bound(state, "s1"), "third");
    state = applyNativeAccountingCommand(state, { id: "duplicate-register", kind: "register", submission: submission() });
    const plan = nativeAccountingWorkMergePlan(state, "third");
    expect(plan.retiredWorkIds).toEqual([first, third].sort());
    expect(plan.survivorWorkId).toBe(nativeWorkForSubmission(state, "second").id);
    expect(Object.keys(plan.mergedSnapshot.works)).toEqual([plan.survivorWorkId]);
    expect(restoreNativeAccountingState(JSON.parse(JSON.stringify(plan.mergedSnapshot)))).toEqual(plan.mergedSnapshot);
    expect(nativeAccountingWorkMergePlan(plan.mergedSnapshot, "s1")).toEqual(plan);
  });
  it("preserves original cancellation, reservations and price histories without re-pricing or adding charges", () => {
    let state = reserve(observe(registered()));
    const originalCost = cost(state);
    state = applyNativeAccountingCommand(state, { id: "price-original", kind: "record_cost", submissionId: "s1", calculation: originalCost });
    state = applyNativeAccountingCommand(state, { id: "cancel-original", kind: "release_local", submissionId: "s1", basis });
    const before = nativeAccountingWorkSnapshot(state, "s1"), known = submission("known", { beneficiaries: ["parent", "child"] });
    state = reserve(registered(known, state), "known-reservation", known.id);
    state = observe(state, "known-usage", usage(), {}, known);
    const knownCost = cost(state, { work: nativeWorkForSubmission(state, known.id), calculation: { id: "known-cost", revision: "1" } });
    state = applyNativeAccountingCommand(state, { id: "price-known", kind: "record_cost", submissionId: known.id, calculation: knownCost });
    state = bound(state, known.id);
    const originalKnown = nativeAccountingWorkSnapshot(state, known.id);
    const plan = nativeAccountingWorkMergePlan(bound(state, "s1"), "s1");
    assertNativeAccountingWorkProgress(plan.mergedSnapshot, before);
    assertNativeAccountingWorkProgress(plan.mergedSnapshot, originalKnown);
    expect(Object.values(plan.mergedSnapshot.reservations).map(r => r.status)).toEqual(["held", "held"]);
    expect(nativeWorkForSubmission(plan.mergedSnapshot, "s1").costCalculations).toEqual([knownCost, originalCost]);
    expect(nativeWorkIndexEntry(plan.mergedSnapshot, "s1")).toMatchObject({ heldReservations: 2,
      beneficiaries: ["child", "parent"], pricedSubtotals: knownCost.subtotals });
  });
  it("rejects missing later durable commands, changed contents, reordered history and corrupt snapshots", () => {
    let original = registered();
    original = applyNativeAccountingCommand(original, { id: "release-a", kind: "release_local", submissionId: "s1", basis });
    const later = reserve(original);
    expect(() => assertNativeAccountingWorkProgress(original, later)).toThrow("progress_not_preserved");
    const changed = applyNativeAccountingCommand(registered(), { id: "release-a", kind: "release_local", submissionId: "s1", basis: { ...basis, revision: "2" } });
    expect(() => assertNativeAccountingWorkProgress(changed, original)).toThrow("progress_not_preserved");
    const reordered = applyNativeAccountingCommand(reserve(registered()), { id: "release-a", kind: "release_local", submissionId: "s1", basis });
    expect(() => assertNativeAccountingWorkProgress(reordered, later)).toThrow("progress_not_preserved");
    const corrupt = JSON.parse(JSON.stringify(later)); corrupt.reservations = {};
    expect(() => assertNativeAccountingWorkProgress(later, corrupt)).toThrow("integrity_invalid");
  });
});

describe("exact cost and applicable prices", () => {
  it("independently reproduces the D08 0.0198 synthetic subtotal without binary rounding", () => {
    const result = cost(observe(registered()));
    expect(result.subtotals).toEqual({ USD: "0.0198" }); expect(result.coverage).toBe("complete");
    expect(result.components.map(c => c.amount)).toEqual(["0.006", "0.0008", "0.009", "0.004"]);
    expect(result.requestedTier).toBe("priority"); expect(result.context.reportedTier).toBe("default");
  });
  it("prices lifetime write categories instead of aggregate writes", () => {
    const state = observe(registered(), "ttl", { ...usage(), input_tokens_details: { cached_tokens: 4000, cache_write_tokens: 3000,
      cache_write_tokens_details: { ttl_30m_tokens: 1000, ttl_12h_tokens: 2000 } } }, { profile: { ...profile, cacheWrites: "lifetimes" } });
    const r = rate();
    const result = cost(state, { rates: [rate({ rates: [...r.rates, ...["ttl_30m_tokens", "ttl_12h_tokens"].map(lifetime => ({
      component: `${writeField}_details.${lifetime}`, unit: "tokens", amount: "3", perUnits: "1000000" }))] })] });
    expect(result.subtotals.USD).toBe("0.0198"); expect(result.components.find(c => c.id === writeField)).toBeUndefined();
  });
  it("uses full input for a context band and does not fill unknown serving/region conditions", () => {
    const state = observe(registered());
    expect(cost(state, { rates: [rate({ inputBand: { minimum: "9000", maximumExclusive: "11000" } })] }).coverage).toBe("complete");
    expect(cost(state, { rates: [rate({ inputBand: { minimum: "0", maximumExclusive: "9000" } })] }).subtotals).toEqual({});
    for (const field of ["reportedTier", "region", "model"])
      expect(cost(state, { context: { ...context, [field]: null } }).coverage).toBe("partial");
    expect(cost(state, { rates: [rate({ protocol: DEEPSEEK_CHAT_COMPLETIONS })] }).subtotals).toEqual({});
  });
  it("does not pick latest/max/cheapest conflicting prices, and retains old calculations", () => {
    const state = observe(registered()), original = cost(state);
    const changed = rate({ ref: { id: "synthetic-price", revision: "2" }, rates: rate().rates.map(r => ({ ...r, amount: "99" })) });
    expect(cost(state, { rates: [rate(), changed] }).coverage).toBe("conflicting");
    expect(cost(state, { rates: [changed] }).revision).not.toBe(original.revision);
    expect(original.subtotals.USD).toBe("0.0198");
  });
  it("keeps a known subtotal when writes or service/storage costs are unpriced", () => {
    const state = observe(registered());
    const result = cost(state, { rates: [rate({ rates: rate().rates.filter(r => r.component !== writeField) })],
      additional: [{ id: "storage-interval", state: "unknown", basis }] });
    expect(result.subtotals.USD).toBe("0.0108"); expect(result.coverage).toBe("partial");
    expect(result.components.find(c => c.id === writeField)?.state).toBe("unpriced");
    expect(cost(state, { chargeCoverage: { state: "unknown", basis } }).coverage).toBe("partial");
  });
  it("never combines currencies or infers a free local runtime", () => {
    const state = observe(registered());
    const result = cost(state, { rates: [rate({ rates: rate().rates.filter(r => r.component !== "output_tokens") }),
      rate({ ref: { id: "output-eur", revision: "1" }, currency: "EUR", rates: rate().rates.filter(r => r.component === "output_tokens") })] });
    expect(result.subtotals).toEqual({ USD: "0.0158", EUR: "0.004" });
    expect(result).not.toHaveProperty("total");
    expect(cost(state, { rates: [] }).subtotals).toEqual({});
  });
  it("durably retains original price bases and corrections without overwriting or repeating usage", () => {
    let state = observe(registered());
    const original = cost(state);
    state = applyNativeAccountingCommand(state, { id: "record-price1", kind: "record_cost", submissionId: "s1", calculation: original });
    const changed = cost(state, { calculation: { id: "calculation", revision: "2" }, rates: [rate({ ref: { id: "new-price", revision: "1" },
      rates: rate().rates.map(r => ({ ...r, amount: "1" })) })] });
    state = applyNativeAccountingCommand(state, { id: "record-price2", kind: "record_cost", submissionId: "s1", calculation: changed });
    state = restoreNativeAccountingState(JSON.parse(JSON.stringify(nativeAccountingWorkSnapshot(state, "s1"))));
    expect(nativeWorkForSubmission(state, "s1").costCalculations).toEqual([original, changed]);
    expect(nativeWorkIndexEntry(state, "s1").pricedSubtotals).toEqual(changed.subtotals);
    expect(original.subtotals.USD).toBe("0.0198");
    expect(() => applyNativeAccountingCommand(state, { id: "tampered-price", kind: "record_cost", submissionId: "s1",
      calculation: { ...original, subtotals: { USD: "0" } } })).toThrow("calculation_identity_conflict");
    state = observe(state, "usage-correction", usage(10000, 600));
    expect(nativeWorkIndexEntry(state, "s1").costCoverage).toBe("unknown");
    expect(nativeWorkForSubmission(state, "s1").costCalculations).toHaveLength(2);
  });
  it("keeps valid priced components when another usage component conflicts", () => {
    let state = observe(registered());
    state = observe(state, "conflicting-output", usage(10000, 600));
    const result = cost(state);
    expect(result.coverage).toBe("conflicting");
    expect(result.subtotals.USD).toBe("0.0158");
    expect(result.components.find(c => c.id === "output_tokens")?.state).toBe("conflicting");
  });
});

describe("WA05 indexed unique-work aggregation and honest cache evidence", () => {
  it("reconciles Parent/Children/shared preparation from unique indexed work without hydrating snapshots", () => {
    let state = createNativeAccountingState();
    const expected = [100, 200, 300, 400];
    const entries = expected.map((n, index) => {
      const s = submission(`s${index}`, { scope: { ...submission().scope, runId: index ? `child-${index}` : "parent" },
        beneficiaries: index === 3 ? ["parent", "child-1", "child-2"] : [] });
      state = observe(registered(s, state), `o${index}`, usage(n, 20, 0, 0), {}, s);
      return nativeWorkIndexEntry(state, s.id);
    });
    const scope = { id: "tree", kind: "selected_descendants" as const, runIds: entries.map(e => e.runId), expectedWorkIds: entries.map(e => e.workId), evidenceBoundary: "journal:4", scanComplete: true };
    for (const fanout of [1, 2, 4, 32]) {
      const aggregate = aggregateNativeWork(Array.from({ length: fanout }, () => entries).flat(), scope);
      expect(aggregate.workIds).toHaveLength(4);
      expect(Object.values(aggregate.protocolTotals)[0]?.inputTokens).toBe(String(expected.reduce((a, b) => a + b, 0)));
      expect(aggregate.counts.observed).toBe(4);
    }
    const parent = aggregateNativeWork(entries.slice(0, 1), { ...scope, kind: "run_only", runIds: ["parent"], expectedWorkIds: [entries[0]!.workId] });
    expect(Object.values(parent.protocolTotals)[0]?.inputTokens).toBe("100");
    const missing = aggregateNativeWork([], scope); expect(missing.counts.missing).toBe(4); expect(missing.monetaryCoverage).toBe("partial");
  });
  it("does not choose among conflicting index revisions or charge one twice", () => {
    const state = observe(registered()), entry = nativeWorkIndexEntry(state, "s1", cost(state));
    const later = nativeWorkIndexEntry(observe(state, "conflict", usage(10000, 600)), "s1");
    const result = aggregateNativeWork([entry, later], { id: "scope", kind: "selected_work", runIds: [], expectedWorkIds: [entry.workId], evidenceBoundary: "1", scanComplete: true });
    expect(result.counts.conflicting).toBe(1); expect(result.pricedSubtotals).toEqual({});
  });
  it("round trips 27 scalar metadata fields with memberships separate, then rejects malformed quantities", () => {
    const state = observe(registered(submission("s1", { beneficiaries: ["z", "a"] })));
    const entry = nativeWorkIndexEntry(state, "s1", cost(state)), metadata = encodeNativeWorkIndexEntryMetadata(entry);
    expect(Object.keys(metadata)).toHaveLength(27); expect(Buffer.byteLength(JSON.stringify(metadata))).toBeLessThanOrEqual(4096);
    expect(metadata).not.toHaveProperty("beneficiaries"); expect(metadata).not.toHaveProperty("protocol");
    expect(decodeNativeWorkIndexEntryMetadata(metadata, ["z", "a"])).toEqual(entry);
    for (const bad of [null, "0", false, -1, NaN, Infinity, 0.1, Number.MAX_SAFE_INTEGER + 1])
      expect(() => decodeNativeWorkIndexEntryMetadata({ ...metadata, inputTokens: bad }, entry.beneficiaries)).toThrow();
    expect(() => decodeNativeWorkIndexEntryMetadata({ ...metadata, outputState: "missing", outputTokens: 0 }, entry.beneficiaries)).toThrow();
    expect(() => decodeNativeWorkIndexEntryMetadata({ ...metadata, pricedSubtotalsJson: '{"USD":0}' }, entry.beneficiaries)).toThrow();
    expect(() => decodeNativeWorkIndexEntryMetadata({ ...metadata, pricedSubtotalsJson: '{"USD":"-1"}' }, entry.beneficiaries)).toThrow();
    expect(() => decodeNativeWorkIndexEntryMetadata({ ...metadata, purpose: "x".repeat(4096) }, entry.beneficiaries)).toThrow();
    expect(() => decodeNativeWorkIndexEntryMetadata(metadata, ["some-other-member"])).toThrow("revision_mismatch");
  });
  it("preserves missing indexed usage as null, not zero, and rejects even self-consistent forged observed metadata", () => {
    const state = observe(registered(), "missing", {}), entry = nativeWorkIndexEntry(state, "s1");
    const metadata = encodeNativeWorkIndexEntryMetadata(entry);
    expect(decodeNativeWorkIndexEntryMetadata(metadata, []).inputTokens).toBeNull();
    const bad = { ...entry, inputTokens: 0, inputState: "missing" as const }; const { revision: _, ...rest } = bad;
    expect(() => encodeNativeWorkIndexEntryMetadata({ ...bad, revision: key(rest) })).toThrow("quantity_invalid");
  });
  it("round trips multi-currency subtotals above 256 bytes within the shared 1024/4096-byte budget", () => {
    const state = observe(registered()), original = nativeWorkIndexEntry(state, "s1", cost(state));
    const { revision: _revision, ...value } = { ...original, costCoverage: "partial" as const,
      pricedSubtotals: { USD: "1".repeat(200), EUR: "2".repeat(200), JPY: "3".repeat(200) } };
    const entry = { ...value, revision: key(value) }, metadata = encodeNativeWorkIndexEntryMetadata(entry);
    expect(Buffer.byteLength(metadata.pricedSubtotalsJson as string, "utf8")).toBeGreaterThan(256);
    for (const scalar of Object.values(metadata)) if (typeof scalar === "string")
      expect(Buffer.byteLength(scalar, "utf8")).toBeLessThanOrEqual(1024);
    expect(Buffer.byteLength(JSON.stringify(metadata), "utf8")).toBeLessThanOrEqual(4096);
    expect(decodeNativeWorkIndexEntryMetadata(metadata, entry.beneficiaries)).toEqual(entry);
  });
  it("computes token-weighted reads once, excludes missing samples, and leaves zero denominator undefined", () => {
    let state = observe(registered(), "a", usage(100, 20, 50, 0));
    const a = nativeWorkIndexEntry(state, "s1"), s = submission("b");
    state = observe(registered(s, state), "b", usage(900, 20, 90, 0), {}, s);
    const b = nativeWorkIndexEntry(state, "b");
    const missing = nativeWorkIndexEntry(observe(registered(submission("m")), "m", {}, {}, submission("m")), "m");
    const result = summarizeNativeCache([a, b, b, missing]);
    expect(Object.values(result.groups)[0]?.ratio).toEqual({ numerator: "140", denominator: "1000" });
    expect(result.coverage).toBe("partial"); expect(result.excluded).toHaveLength(1);
    const zero = nativeWorkIndexEntry(observe(registered(), "zero", { input_tokens: 0, output_tokens: 0, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } }), "s1");
    expect(Object.values(summarizeNativeCache([zero]).groups)[0]?.ratio).toBeNull();
  });
  it("does not turn continuation/prefix/latency into applied caching, custody or savings", () => {
    const evidence = projectNativeCacheEvidence({ protocol: OPENAI_RESPONSES, requested: {}, reported: null, settingsBasis: basis,
      opportunity: [{ kind: "remote_continuation", basis }, { kind: "stable_prefix", basis }], latency: { milliseconds: 1, clockDomain: "monotonic", basis } });
    expect(evidence.appliedPolicy).toBe("unknown");
    expect(evidence.conclusions).toMatchObject({ guaranteedHit: false, avoidedCost: "unestablished", exactMatchedPrefix: "unestablished" });
  });
  it("validates explicitly supported native controls without mutating history or inventing options", () => {
    const validate = (settings: Record<string, unknown>) => validateResponsesCacheSettings({ settings,
      support: { basis, fields: ["prompt_cache_options", "prompt_cache_retention", "prompt_cache_key"], modes: ["auto", "explicit"], retentions: ["30m", "12h", "24h"] },
      disclosure: { basis, permittedRetentions: ["30m"] } });
    expect(validate({})).toEqual({});
    expect(validate({ prompt_cache_options: { ttl: "30m", mode: "auto" } })).toEqual({ prompt_cache_options: { ttl: "30m", mode: "auto" } });
    expect(() => validate({ prompt_cache_options: { ttl: "30m" }, prompt_cache_retention: "24h" })).toThrow("incompatible");
    expect(() => validate({ prompt_cache_options: { ttl: "12h" } })).toThrow("unauthorized");
    expect(() => validate({ invented_cache: true })).toThrow("unsupported");
  });
  it("rejects body override fields even when a caller advertises them as cache support", () => {
    const input = { support: { basis, fields: ["model", "input", "instructions", "prompt_cache_key", "prompt_cache_options"] as any,
      optionFields: ["model", "ttl", "mode"], modes: ["auto", "1"], retentions: ["30m"] }, disclosure: { basis, permittedRetentions: ["30m"] } };
    for (const field of ["model", "input", "instructions"]) expect(() => validateResponsesCacheSettings({ ...input, settings: { [field]: "override" } })).toThrow("control_unsupported");
    expect(() => validateResponsesCacheSettings({ ...input, settings: { prompt_cache_options: { model: "override" } } })).toThrow("option_unsupported");
    for (const value of [null, 1, true, [], {}]) {
      expect(() => validateResponsesCacheSettings({ ...input, settings: { prompt_cache_key: value } })).toThrow();
      expect(() => validateResponsesCacheSettings({ ...input, settings: { prompt_cache_options: { ttl: value } } })).toThrow();
      expect(() => validateResponsesCacheSettings({ ...input, settings: { prompt_cache_options: { mode: value } } })).toThrow();
      expect(() => validateResponsesCacheSettings({ ...input, support: { ...input.support, fields: ["prompt_cache_retention"] }, settings: { prompt_cache_retention: value } })).toThrow();
    }
  });
});

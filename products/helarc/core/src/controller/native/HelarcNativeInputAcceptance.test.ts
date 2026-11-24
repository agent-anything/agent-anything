import { describe, expect, it } from "vitest";
import { OPENAI_RESPONSES } from "@agent-anything/model-interaction/protocol";
import { modelInputValueDigest as digest } from "@agent-anything/model-interaction/input";
import { bindNativeInputManifest, nativeInputSettings, prepareResponses } from "@agent-anything/provider-integrations/native";
import { helarcNativeInputAcceptance } from "./HelarcNativeInputAcceptance.js";

function fixture(): Parameters<typeof helarcNativeInputAcceptance>[0] {
  const scope = { id: "scope", runId: "root", recipient: "root", purpose: "task", target: "configuration:1",
    continuity: "root-task", owner: "native-input", authorityBasis: "permission:1" };
  const range = { materialId: "material", version: "1", start: 0, end: 10, coordinate: "bytes" as const };
  const hold = { id: "hold", instanceId: "instance", consumer: { runId: "root", recipient: "root", purpose: "task" },
    responsibility: "input" as const, range, basis: "original", releaseCondition: "accepted" };
  const prepared = prepareResponses({ model: "fixture", input: [{ role: "user", content: "Keep the original task." }],
    purpose: { id: "task", revision: "1" }, stream: false, store: false });
  const settings = nativeInputSettings(prepared.body);
  const manifest = bindNativeInputManifest({ protocol: OPENAI_RESPONSES,
    scope: { id: scope.id, runId: scope.runId, recipientId: scope.recipient, purpose: { id: "task", revision: "1" }, compositionDigest: digest("original") },
    target: { configuration: scope.target, model: "fixture", connection: "connection:1", disclosure: "disclosure:1" },
    selection: { id: "selection", revision: "1", boundary: "delivery:1", judgments: ["preserve"] },
    groups: [{ id: "user", representation: { id: "representation", revision: "1" }, sources: ["user:1"], holds: [hold.id],
      deliveries: ["delivery:1"], requires: [], items: prepared.body.input as never, replay: "local" }], settings,
    settingSources: Object.keys(settings).map(field => ({ field, source: "original-config", digest: digest(settings[field]) })) });
  const native = { kind: "helarc_native_input" as const, manifest, wire: { body: prepared.encoded, digest: prepared.digest },
    prefixGroups: 0, predecessor: null, continuity: { kind: "responses" as const, policy: "native_replay" as const, previous: null,
      conditions: { basis: "current-authority", authorized: true, disclosureRevision: "disclosure:1", remoteStorage: false,
        targetSupport: "established" as const, predecessor: "available" as const, reestablish: false, policyChange: false } } };
  return { id: "accept", scope, expectedSelectionId: null, expectedControlRevision: 0,
    selection: { id: "selection", representations: manifest.groups.map(g => g.representation), judgmentIds: ["preserve"], holds: [] },
    retainedSelectionId: null, native, judgment: { id: "combination", runId: "root", owner: scope.owner, kind: "combination",
      subjects: manifest.groups.map(g => g.representation), inputs: [range], purpose: "task", target: scope.target,
      methodRevision: "native-assembly:1", dependencies: { inputDigest: digest(native) }, evidenceSources: [], coverage: [range],
      conclusion: "supported", limitations: [], basis: "original-selection" }, inputId: "input", activityId: "activity",
    stageRequestId: "stage", stageKind: "native-model", capabilities: [], inputHolds: [hold], releaseHolds: [] };
}

describe("native input shared acceptance", () => {
  it("hands one exact native input, selection, custody and finite delivery set to the shared boundary", () => {
    const input = fixture(), proposal = helarcNativeInputAcceptance(input);
    const part = proposal.parts.find(p => p.kind === "selection_input")!.proposal as any;
    expect(part.input.exactInput).toBe(input.native);
    expect(part.input.deliveries).toEqual([{ id: "delivery:1", position: "/manifest/groups/0" }]);
    expect(proposal.parts.find(p => p.kind === "stage_submission")!.proposal).toMatchObject({ input: input.native });
    expect(input.native.wire.body).not.toContain("instructions");
  });
  it("rejects mismatched native wire, selection and Child custody before submission", () => {
    const input = fixture();
    expect(() => helarcNativeInputAcceptance({ ...input, native: { ...input.native, wire: { ...input.native.wire, body: "{}" } } })).toThrow("realization_changed");
    expect(() => helarcNativeInputAcceptance({ ...input, selection: { ...input.selection!, representations: [] } })).toThrow("selection_changed");
    expect(() => helarcNativeInputAcceptance({ ...input, selection: { ...input.selection!, representations: [...input.selection!.representations,{id:"retained-but-unused",revision:"1"}] } })).toThrow("selection_changed");
    expect(() => helarcNativeInputAcceptance({ ...input, inputHolds: [{ ...input.inputHolds[0], consumer: { runId: "child", recipient: "child", purpose: "task" } }] })).toThrow("hold_missing");
  });
  it("does not accept a stale preservation judgment as authority for changed input", () => {
    const input = fixture();
    expect(() => helarcNativeInputAcceptance({ ...input, judgment: { ...input.judgment, dependencies: { inputDigest: "old" } } })).toThrow("owner_basis_invalid");
  });
  it("requires proven predecessor coverage, not merely a matching suffix and response ID", () => {
    const input = fixture(), body = JSON.parse(input.native.wire.body);
    body.input = []; body.previous_response_id = "unproven";
    const native = { ...input.native, prefixGroups: 1, predecessor: "unproven", wire: { body: JSON.stringify(body), digest: digest(body) } };
    expect(() => helarcNativeInputAcceptance({ ...input, native,
      judgment: { ...input.judgment, dependencies: { inputDigest: digest(native) } } })).toThrow("prefix_unproven");
  });
  it("reuses verified retained selection metadata while keeping current input custody", () => {
    const input = fixture();
    const proposal = helarcNativeInputAcceptance({ ...input, selection: null, retainedSelectionId: input.selection!.id, retainedSelection: input.selection! });
    expect((proposal.parts.find(p => p.kind === "selection_input")!.proposal as any).selection).toBeNull();
    expect(() => helarcNativeInputAcceptance({ ...input, selection: null, retainedSelectionId: "other", retainedSelection: input.selection! })).toThrow("selection_changed");
  });
});

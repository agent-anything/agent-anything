import { describe, expect, it, vi } from "vitest";
import type { InspectionRecorder } from "../recording/index.js";
import type { ProviderDescriptor } from "@agent-anything/model-interaction";
import { DefinitionInspectionAdapter } from "./DefinitionInspectionAdapter.js";

describe("Provider definition configuration identity", () => {
  it("distinguishes configurations on one model revision without including secrets", () => {
    const offer = vi.fn();
    const recorder = { capturePolicyRevision: "1", offer, ref: vi.fn((owner, kind, id, runId, revision) => ({ owner, kind, id, runId, revision })) };
    const adapter = new DefinitionInspectionAdapter(recorder as unknown as InspectionRecorder);
    const descriptor = { id: "provider", name: "Provider", metadata: { generationConfiguration: { think: false } } } as unknown as ProviderDescriptor;
    adapter.provider(descriptor, "same-model");
    adapter.provider({ ...descriptor, metadata: { generationConfiguration: { think: true } } }, "same-model");
    adapter.provider(descriptor, "same-model");
    expect(offer.mock.calls[0]![0].id).not.toBe(offer.mock.calls[1]![0].id);
    expect(offer.mock.calls[0]![0].id).toBe(offer.mock.calls[2]![0].id);
    expect(offer.mock.calls[1]![0].contents[0].value.metadata.generationConfiguration.think).toBe(true);
  });
});

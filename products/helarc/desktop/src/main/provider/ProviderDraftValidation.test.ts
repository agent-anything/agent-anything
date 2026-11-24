import {describe,expect,it} from "vitest";
import {defaultProviderDraft,previewProviderPolicy,snapshotProviderDraft} from "./ProviderDraftValidation.js";

describe("provider policy preview and acceptance",()=>{
  const original=defaultProviderDraft("openai.responses","gpt-5.4");
  const {inRequestCompaction:documented,...withoutPolicy}=original;
  it("previews a scoped default without adding it to a recovered configuration",()=>{
    expect(documented?.support).toBe("accepted");
    expect(snapshotProviderDraft(withoutPolicy)).toEqual(withoutPolicy);
    expect(previewProviderPolicy({draft:withoutPolicy})).toEqual(documented);
    expect(previewProviderPolicy({draft:{...withoutPolicy,baseUrl:"https://example.test/v1"}}).support).toBe("unassessed");
    expect(snapshotProviderDraft(original)).toEqual(original);
  });
  it("rejects malformed, cross-target and cross-protocol evidence at both boundaries",()=>{
    const chat=defaultProviderDraft("ollama.chat","local");
    for(const [draft,code] of [
      [{...original,inRequestCompaction:{...documented!,reviewedAt:"2026-02-30"}},"in_request_compaction_policy_invalid"],
      [{...original,model:"another"},"provider_compaction_target_changed"],
      [{...chat,inRequestCompaction:{...documented!,target:chat.inRequestCompaction!.target}},"provider_compaction_protocol_unsupported"],
    ] as const){
      expect(()=>previewProviderPolicy({draft})).toThrow(code);
      expect(()=>snapshotProviderDraft(draft)).toThrow(code);
    }
  });
  it("distinguishes a missing policy from an explicitly malformed one",()=>{
    expect(()=>snapshotProviderDraft({...withoutPolicy,inRequestCompaction:null})).toThrow("in_request_compaction_policy_invalid");
  });
});

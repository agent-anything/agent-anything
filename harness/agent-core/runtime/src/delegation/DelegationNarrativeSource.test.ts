import {describe,it,expect} from "vitest";
import {createDelegationNarrativeSource,snapshotRetainedDelegationNarrative,verifyDelegationNarrativeSource} from "./DelegationNarrativeSource.js";

describe("retained delegation narrative",()=>{
  const cause={run:{id:"child"},id:"cause",revision:"1"};
  const text="first\r\n\u539f\u6587\n\u{1f642}";
  const source=createDelegationNarrativeSource("report","child",cause,text);
  it("retains exact newlines and distinguishes UTF-8 bytes from UTF-16 units",()=>{
    expect(source.bytes).toBe(Buffer.byteLength(text));expect(source.codeUnits).toBe(text.length);
    expect(snapshotRetainedDelegationNarrative({source,text},source).text).toBe(text);
  });
  it.each(["changed",text.replace("\r\n","\n"),text.slice(0,3)])("rejects changed original text %j",changed=>{
    expect(()=>verifyDelegationNarrativeSource(source,"child",cause,changed)).toThrow("source_mismatch");
  });
  it("rejects a different record, Run or terminal cause",()=>{
    expect(()=>snapshotRetainedDelegationNarrative({source:{...source,recordId:"other"},text},source)).toThrow("source_mismatch");
    expect(()=>verifyDelegationNarrativeSource(source,"other",{...cause,run:{id:"other"}},text)).toThrow("source_mismatch");
    expect(()=>verifyDelegationNarrativeSource(source,"child",{...cause,revision:"2"},text)).toThrow("source_mismatch");
  });
  it("does not silently replace malformed UTF-16 while retaining UTF-8",()=>{
    expect(()=>createDelegationNarrativeSource("report","child",cause,"\ud800")).toThrow("encoding_invalid");
  });
});

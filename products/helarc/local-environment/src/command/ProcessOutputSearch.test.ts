import {describe, expect, it} from "vitest";
import {searchProcessOutput} from "./ProcessOutputSearch.js";
import type {ProcessOutputCheckpoint} from "./ProcessOutputStore.js";
function checkpoint(text: readonly string[]): ProcessOutputCheckpoint {
  let end = 0; const segments = text.map(value => {const start=end; end+=Buffer.byteLength(value); return {byteStart:start,byteEnd:end,decoderInputStart:0,text:value};});
  const stream = {received:end,retained:end,projected:end,omitted:0,segments,projection:{text:"",encoding:"utf-8",encodingSource:"utf8-validation",integrity:"exact",replacementCount:0},projectionPending:false,textBytes:end};
  return {executionId:"task",maximumBytes:1048576,failure:null,streams:{stdout:stream,stderr:{...stream,segments:[],received:0,retained:0,projected:0,textBytes:0}}} as ProcessOutputCheckpoint;
}
describe("process literal search",()=>{
  it("finds cross-segment matches, with UTF-8 view positions independent of raw bytes",()=>{
    const result=searchProcessOutput(checkpoint(["a中NE","EDLE😀z"]),{query:"NEEDLE"});
    expect(result.matches).toEqual([{byte_start:4,byte_end:15,text:"NEEDLE😀z"}]);
    expect(result.coordinate).toBe("projected_utf8_bytes");
  });
  it("freezes the prefix and bounds scans independently of match count",()=>{
    const value=checkpoint(["hit ","hit ","z".repeat(300000)]), first=searchProcessOutput(value,{query:"hit",limit:1});
    const expanded=checkpoint(["hit ","hit ","z".repeat(300000),"hit new"]);
    const second=searchProcessOutput(expanded,{query:"hit",search_cursor:first.next_search_cursor!,limit:16});
    expect(second.matches).toHaveLength(1); expect(second.frontier).toEqual(first.frontier); expect(second.exhausted).toBe(false);
    expect(second.scanned_bytes).toBeLessThanOrEqual(262144);
    expect(searchProcessOutput(expanded,{query:"hit",search_cursor:second.next_search_cursor!}).matches).toEqual([]);
    expect(searchProcessOutput(expanded,{query:"hit"}).matches).toHaveLength(2);
    expect(()=>searchProcessOutput(expanded,{query:"different",search_cursor:first.next_search_cursor!})).toThrow("cursor");
  });
});

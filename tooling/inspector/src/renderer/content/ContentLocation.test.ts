import { describe, expect, it } from "vitest";
import { locateJsonPointer } from "./ContentLocation.js";
describe("Recorded JSON locations",()=>{
  it("locates escaped names and array items without rewriting source numbers",()=>{
    const text='{"a/b":{"~key":[9007199254740993,"second"]}}';
    const position=locateJsonPointer(text,"/a~1b/~0key/0")!;
    expect(text.slice(position.offset,position.offset+position.length)).toBe("9007199254740993");
    expect(locateJsonPointer(text,"")).toEqual({offset:0,length:text.length});
  });
  it("does not guess missing, invalid or incomplete locations",()=>{
    for(const pointer of ["/missing","/a/~3","/a/01","/a/-","invalid"]) expect(locateJsonPointer('{"a":[1]}',pointer)).toBeNull();
    expect(locateJsonPointer('{"a":',"/a")).toBeNull();
  });
});

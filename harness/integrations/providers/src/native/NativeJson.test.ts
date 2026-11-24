import { describe, expect, it } from "vitest";
import { snapshotModelJsonValue } from "@agent-anything/model-interaction";
import { digest, validateNativePreparedEncoding, type JsonObject } from "./NativeJson.js";

describe("native prepared encoding integrity", () => {
  const body = {model:"fixture", input:[{role:"user",content:"first"},{role:"assistant",content:"second"}], stream:false};
  const prepared = {body, encoded:JSON.stringify(body), digest:digest(body)};
  it("accepts a reordered parsed view while returning the original wire order", () => {
    const view = snapshotModelJsonValue(body,"test") as JsonObject;
    expect(JSON.stringify(view)).not.toBe(prepared.encoded);
    const recovered = validateNativePreparedEncoding({...prepared,body:view},"changed");
    expect(JSON.stringify(recovered)).toBe(prepared.encoded);
    expect(recovered.input).toEqual(body.input);
  });
  it.each([
    {...prepared,body:{...body,model:"different"}},
    {...prepared,body:{...body,input:[...body.input].reverse()}},
    {...prepared,encoded:'{"model":"different"}'},
    {...prepared,encoded:'{"model":"discarded",'+prepared.encoded.slice(1)},
    {...prepared,encoded:prepared.encoded+" "},
    {...prepared,encoded:"{"},
    {...prepared,encoded:"null"},
    {...prepared,digest:"untrusted"},
  ])("rejects changed or non-original bodies %#", value => {
    expect(() => validateNativePreparedEncoding(value,"changed")).toThrow("changed");
  });
  it("does not erase unsupported view values before validation", () => {
    expect(() => validateNativePreparedEncoding({...prepared,body:{...body,unsupported:undefined}},"changed")).toThrow();
  });
});

import {test} from "node:test";
import assert from "node:assert/strict";
import {nativeMethodPeer} from "./native-method-peer.mjs";
const message=value=>({role:"user",content:JSON.stringify(value)});
const source=text=>({alias:"original",role:"source",text});
const job=kind=>({job:{kind,scope:["original"],candidates:kind==="check"?["candidate"]:[]},requirements:[{id:"facts"}]});
test("retains the source's role and exact Host facts, not numbers from background",()=>{
  const items=[{role:"user",content:"Host: workspace X, read-only, network denied"}];
  const result=nativeMethodPeer([message(source(JSON.stringify({kind:"native_working_source",originRunId:"child",items}))),
    message({role:"read_only_background",items:[source("Unrelated 8422")]}),message(job("generate"))]);
  assert.deepEqual(JSON.parse(result.parts[0].text),{originRunId:"child",items});
});
test("retains repeated-line multiplicity and original uncertainty",()=>{
  const result=nativeMethodPeer([message(source("8422 is unverified\n"+"same detail\n".repeat(50))),message(job("generate"))]);
  assert.equal(result.parts[0].text,"8422 is unverified\nIdentical line repeated 50 times: same detail\n");
});
test("rejects a candidate that replaced Host facts with unrelated result data",()=>{
  const result=nativeMethodPeer([message(source("Read-only; no approval authority")),message({role:"candidate",alias:"candidate",text:"8422 is unverified"}),message(job("check"))]);
  assert.equal(result.findings.source_to_candidate.conclusion,"unsupported");assert(result.missing.length);
});
test("accepts an exact synthetic account but not an absent source",()=>{
  const result=nativeMethodPeer([message(source("Fact remains uncertain")),message({role:"candidate",alias:"candidate",text:"Fact remains uncertain"}),message(job("check"))]);
  assert.equal(result.findings.source_to_candidate.conclusion,"supported");
  assert.throws(()=>nativeMethodPeer([message(job("generate"))]),/explicit source/);
});

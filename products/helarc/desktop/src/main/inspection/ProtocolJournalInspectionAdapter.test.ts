import { describe, expect, it } from "vitest";
import { ProtocolJournalInspectionAdapter } from "./ProtocolJournalInspectionAdapter.js";

describe("native evidence investigation", () => {
  it("links accepted scope, native evidence, input, source and dependencies without fetching bodies", () => {
    const offered: any[] = [];
    const recorder = { ref: (owner: string, kind: string, id: string, runId: string, revision?: string) => ({ owner, kind, id, runId, revision }),
      offer: (record: unknown) => { offered.push(record); } };
    const adapter = new ProtocolJournalInspectionAdapter(recorder as never);
    const base = { activityId: "activity", runId: "root", occurredAt: "2026-11-13T00:00:00Z" };
    adapter.observe({ ...base, sequence: 1, kind: "evidence_scope", identity: "scope-accepted", value: { activityId: "activity", scope: { id: "scope" } } });
    adapter.observe({ ...base, sequence: 2, kind: "evidence", identity: "usage-accepted", value: {
      scopeId: "scope", kind: "usage", key: "work", revision: 1, owner: "native", activityId: "activity",
      content: { id: "usage", activityId: "activity", bytes: 4096, digest: "digest:usage" },
      references: [{ id: "input", activityId: "activity", bytes: 16384, digest: "digest:input" }],
      dependencies: [{ activityId: "activity", ref: { id: "original-response", revision: "1" } }],
      metadata: { tokens: 12 }, memberships: ["root", "child"] } });
    const text = JSON.stringify(offered);
    expect(text).toContain("scope:usage:work"); expect(text).toContain("original-response");
    expect(text).toContain("digest:input"); expect(text).not.toContain("bytesBase64");
    expect(offered[0].links[1].to.id).toBe("scope");
  });
  it("links atomic work retirement to canonical and original versions without inventing a missing prior contribution",()=>{
    const offered:any[]=[];
    const recorder={ref:(owner:string,kind:string,id:string,runId:string,revision?:string)=>({owner,kind,id,runId,revision}),
      offer:(record:unknown)=>{offered.push(record);}};
    const adapter=new ProtocolJournalInspectionAdapter(recorder as never);
    const content=(id:string)=>({id,activityId:"activity",bytes:8000,digest:`digest:${id}`});
    adapter.observe({activityId:"activity",runId:"root",occurredAt:"2026-11-13T00:00:00Z",sequence:3,kind:"usage_merge",identity:"merge-accepted",
      value:{scopeId:"scope",mergeId:"merge",owner:"native",acceptanceId:"accepted",version:3,
        survivor:{key:"canonical",revision:2,content:content("merged-body")},
        retired:[{key:"previous",previous:{revision:0,content:content("old-body")}}, {key:"not-persisted",previous:null}]}});
    const links=offered[0].links;
    expect(links).toContainEqual(expect.objectContaining({from:expect.objectContaining({id:"scope:usage-retirement:previous"}),
      to:expect.objectContaining({id:"scope:usage:canonical",revision:"2"})}));
    expect(links).toContainEqual(expect.objectContaining({from:expect.objectContaining({id:"scope:usage:previous",revision:"0"}),
      to:expect.objectContaining({id:"scope:usage-retirement:previous"})}));
    expect(links).toContainEqual(expect.objectContaining({from:expect.objectContaining({id:"old-body",revision:"digest:old-body"})}));
    expect(links.some((link:any)=>link.from.id==="scope:usage:not-persisted")).toBe(false);
    expect(JSON.stringify(offered)).not.toContain("bytesBase64");
  });
});

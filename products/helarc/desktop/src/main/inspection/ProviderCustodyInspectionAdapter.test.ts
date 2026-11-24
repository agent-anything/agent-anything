import { describe, expect, it } from "vitest";
import { ProviderCustodyInspectionAdapter } from "./ProviderCustodyInspectionAdapter.js";

describe("Provider custody inspection", () => {
  it("records safe timing and original durable identities without replaying already offered facts", async () => {
    const offered: unknown[] = [];
    const recorder = { ref: (owner: string, kind: string, id: string, revision: string | null) => ({ owner, kind, id, revision }), offer: (record: unknown) => { offered.push(record); },
      offerWhenReady:async(record:unknown)=>{offered.push(record);return true;},confirmNativeWork:(work:()=>Promise<void>)=>work()};
    const adapter = new ProviderCustodyInspectionAdapter(recorder as never, "registry");
    adapter.observe({ operation: "resolve", stage: "vault", outcome: "ok", durationMs: 5, subjectId: "connection" });
    const fact = { sequence: 1, kind: "configuration_committed", subjectId: "connection", occurredAt: "2026-11-11T00:00:00.000Z" };
    const read = async (after: number) => after < 1 ? [fact] : [];
    await adapter.replay(read); await adapter.replay(read);
    expect(offered).toHaveLength(2);
    expect(offered[1]).toMatchObject({ id: "provider-custody:registry:1", links: [expect.any(Object)] });
    expect(JSON.stringify(offered)).not.toContain("Helarc/Provider/");
    expect(JSON.stringify(offered)).not.toContain("equalityTag");
  });
  it("re-reads only the unconfirmed page and presents the same IDs on retry",async()=>{
    const offered:string[]=[],reads:number[]=[];
    let fail=true;
    const adapter=new ProviderCustodyInspectionAdapter({ref:()=>({}),offer:()=>true,
      offerWhenReady:async(r:{id:string})=>{offered.push(r.id);return true;},
      confirmNativeWork:async(work:()=>Promise<void>)=>{await work();if(fail&&offered.length===102){fail=false;throw Error("receipt unavailable");}}
    } as never,"registry");
    const events=Array.from({length:102},(_,i)=>({sequence:i+1,kind:"configuration_committed",subjectId:"connection",occurredAt:"2026-11-11T00:00:00Z"}));
    const read=async(after:number,limit:number)=>{reads.push(after);return events.slice(after,after+limit);};
    await expect(adapter.replay(read)).rejects.toThrow("receipt unavailable");await adapter.replay(read);
    expect(reads).toEqual([0,100,100,102]);expect(offered.slice(100,102)).toEqual(offered.slice(102));
  });
});

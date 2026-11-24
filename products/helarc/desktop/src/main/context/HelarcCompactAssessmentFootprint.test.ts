import {expect,it,vi} from "vitest";
import {confirmUnstartedCompactAssessment as confirm} from "./HelarcCompactAssessmentFootprint.js";

const signal=new AbortController().signal;
const reader=()=>({native:vi.fn(async(_id:string):Promise<unknown>=>null),preparation:vi.fn(async(_id:string):Promise<unknown>=>null),
  connection:vi.fn(async(_id:string):Promise<unknown>=>null)});
it("checks all three generations and their exact measurements against explicit absence",async()=>{
  const r=reader(),ids=await confirm("original",signal,r);
  expect(new Set(ids).size).toBe(6);
  for(const id of ids){
    expect(r.native).toHaveBeenCalledWith(id);expect(r.preparation).toHaveBeenCalledWith(id+":prepare");
    expect(r.connection).toHaveBeenCalledWith(id+":connection");
  }
});
it.each(["native","preparation","connection"] as const)("does not settle over a retained %s footprint",async field=>{
  const r=reader();r[field].mockImplementation(async id=>id.includes("judgment:input-count")?{}:null);
  await expect(confirm("original",signal,r)).rejects.toThrow("requires_reconciliation");
});
it("includes the optional correction and its count for compositions that can send them",async()=>{
  const r=reader(),ids=await confirm("original",signal,r,true);
  expect(new Set(ids).size).toBe(8);
  const count="original:compact-assessment:plan-ownership:input-count";
  expect(ids).toContain(count);expect(r.connection).toHaveBeenCalledWith(count+":connection");
  r.native.mockImplementation(async id=>id===count?{}:null);
  await expect(confirm("original",signal,r,true)).rejects.toThrow("requires_reconciliation");
});
it("never treats an indeterminate read, a storage failure, or cancellation as absence",async()=>{
  const r=reader();r.native.mockResolvedValueOnce(undefined);
  await expect(confirm("original",signal,r)).rejects.toThrow("requires_reconciliation");
  r.preparation.mockRejectedValueOnce(new Error("journal unavailable"));
  await expect(confirm("original",signal,r)).rejects.toThrow("journal unavailable");
  await expect(confirm("original",AbortSignal.abort(),r)).rejects.toThrow();
});

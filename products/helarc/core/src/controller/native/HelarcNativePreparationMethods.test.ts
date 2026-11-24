import {describe,it,expect,vi} from "vitest";
import {HelarcNativePreparationMethods} from "./HelarcNativePreparationMethods.js";

function fixture(){
  const local={purpose:{digest:"local-original"},prepareSubmission:vi.fn(()=>["local"]),describe:vi.fn(async()=>({state:"ready"})),prepareClosure:vi.fn(async()=>[])},
    compact={purpose:{digest:"compact-original"},prepareSubmission:vi.fn(()=>["compact"]),describe:vi.fn(async()=>({state:"unknown"})),prepareClosure:vi.fn(async()=>[])};
  const command=vi.fn(async()=>({intent:{purpose:{digest:"compact-original"}}}));
  return {local,compact,command,work:new HelarcNativePreparationMethods({activities:{command},local,compact} as never)};
}
describe("native preparation original owner",()=>{
  it("routes new work by the explicit method, not the current provider preference",()=>{
    const f=fixture();
    expect(f.work.prepareSubmission({} as never,{method:"summarize"} as never)).toEqual(["local"]);
    const request={method:"protocol",execution:{owner:"openai.responses.compact",protocol:{id:"openai.responses"}}} as const;
    expect(f.work.prepareSubmission({} as never,request as never)).toEqual(["compact"]);
    expect(f.compact.prepareSubmission).toHaveBeenCalledWith({},request);
    expect(()=>f.work.prepareSubmission({} as never,{...request,execution:{...request.execution,owner:"unknown"}} as never)).toThrow("owner_unavailable");
  });
  it("restores the exact original purpose for observation and closure",async()=>{
    const f=fixture();expect(await f.work.describe("original")).toEqual({state:"unknown"});
    await f.work.prepareClosure("original","no consumers");
    expect(f.compact.prepareClosure).toHaveBeenCalledWith("original","no consumers");
    expect(f.local.describe).not.toHaveBeenCalled();expect(f.local.prepareClosure).not.toHaveBeenCalled();
    f.command.mockResolvedValue({intent:{purpose:{digest:"local-original"}}});
    expect(await f.work.describe("local")).toEqual({state:"ready"});
  });
  it("rejects changed or missing original owners rather than falling back",async()=>{
    const f=fixture();f.command.mockResolvedValue({intent:{purpose:{digest:"changed"}}});
    await expect(f.work.describe("original")).rejects.toThrow("original_owner_unavailable");
    await expect(f.work.prepareClosure("original","closed")).rejects.toThrow("original_owner_unavailable");
    f.command.mockResolvedValue(null as never);
    await expect(f.work.describe("missing")).rejects.toThrow("original_path_unavailable");
  });
});

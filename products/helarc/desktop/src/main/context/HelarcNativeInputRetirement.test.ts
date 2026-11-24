import {describe,it,expect,vi} from "vitest";
import type {ContextInputUse,ContextUseHead} from "@agent-anything/context/selection";
import type {ProtocolExecutionState} from "@agent-anything/agent-runtime/model-access";
import type {HelarcExecutionStore} from "../execution-storage/HelarcExecutionStore.js";
import {HelarcNativeInputRetirement} from "./HelarcNativeInputRetirement.js";

function fixture(){
  const scope={id:"scope",runId:"parent",recipient:"parent-agent",purpose:"task",owner:"context-representation",
    continuity:"parent",target:"original-target",authorityBasis:"original-authority"};
  const hold={id:"input-hold",instanceId:"report",responsibility:"input" as const,basis:"input",consumer:scope,
    range:{materialId:"child-report",version:"1",coordinate:"bytes" as const,start:0,end:10},releaseCondition:"input settled"};
  const use:ContextInputUse={scope,acceptanceId:"input-admission",control:{scopeId:"scope",revision:2,allowed:true,basis:"control"},
    currentSelectionId:"selection",retired:null,settled:true,claimed:true,liveHoldIds:[hold.id],
    input:{id:"input",activityId:"original-activity",scopeId:"scope",selectionId:"selection",stageRequestId:null,
      nativeConsumer:{protocol:{id:"openai.responses",revision:"1"},compositionDigest:"original-composition"},
      target:"original-target",exactInputDigest:"original-input",deliveries:[],holds:[hold],combinationJudgmentId:"judgment"}};
  const native={activity:{scope:{runId:scope.runId,recipientId:scope.recipient,purpose:{id:scope.purpose,revision:"1"},
    activityId:use.input.activityId,compositionDigest:"original-composition"},composition:{composition:{task:{purpose:{id:scope.purpose,revision:"1"}}}}},
    contextInput:{id:"input",digest:"original-input"},accepted:{id:"original-acceptance",revision:"1"},cancelled:false,retentionReleased:false} as unknown as ProtocolExecutionState;
  const receipt={outcome:"accepted"},selection={id:"selection",representations:[],judgmentIds:[],holds:[{...hold,id:"selection-hold",responsibility:"selection" as const,basis:"selection"}]};
  const head:ContextUseHead={scope,control:use.control,selection};
  const store={contextSelections:{command:vi.fn(async(c:any)=>{if(c.kind==="input_use")return use;throw new Error("unexpected body read");})},
    protocolJournal:{command:vi.fn(async(c:any)=>{if(c.kind==="state")return native;throw new Error("unexpected native content read");})},
    readRunControl:vi.fn(async()=>({terminal:true,commitId:"terminal",revision:8})),
    sharedAcceptance:{query:vi.fn(async(_id:string)=>receipt),accept:vi.fn(async(_proposal:unknown)=>receipt)}};
  return {use,native,head,store,owner:new HelarcNativeInputRetirement(store as unknown as HelarcExecutionStore)};
}
describe("native task input responsibility retirement",()=>{
  it("reuses the original input receipt and releases only input-use holds",async()=>{
    const f=fixture();await expect(f.owner.retire(f.use)).resolves.toBe("retired");
    const proposal=f.store.sharedAcceptance.accept.mock.calls[0]![0] as any;
    expect(proposal.parts).toEqual([
      {owner:"context_selection",kind:"input_retirement",proposal:{inputIds:["input"],withdrawals:[],basis:"input:use-complete"}},
      {owner:"material_custody",kind:"holds",proposal:{acquire:[],release:["input-hold"],basis:"input:use-complete"}}]);
    expect(f.store.protocolJournal.command).toHaveBeenCalledTimes(1);
    expect(f.store.contextSelections.command).toHaveBeenCalledWith({kind:"input_use",inputId:"input"});
  });
  it("withdraws the terminal recipient's current selection without retiring its unresolved inputs",async()=>{
    const f=fixture();await f.owner.withdraw(f.head);
    const proposal=f.store.sharedAcceptance.accept.mock.calls[0]![0] as any;
    expect(proposal.parts[0].proposal).toMatchObject({inputIds:[],withdrawals:[{scopeId:"scope",expectedSelectionId:"selection",expectedControlRevision:2}]});
    expect(proposal.parts[1].proposal.release).toEqual(["selection-hold"]);
    expect(f.store.protocolJournal.command).not.toHaveBeenCalled();
  });
  it("does not withdraw a running recipient's reusable selection",async()=>{
    const f=fixture();f.store.readRunControl.mockResolvedValue({terminal:false,commitId:"working",revision:7});
    await f.owner.withdraw(f.head);expect(f.store.sharedAcceptance.accept).not.toHaveBeenCalled();
  });
  it("does not retire unknown native work merely because the recipient is terminal",async()=>{
    const f=fixture();Object.assign(f.use,{settled:false});Object.assign(f.native,{accepted:null,cancelled:true});
    await expect(f.owner.retire(f.use)).resolves.toBe("pending");expect(f.store.sharedAcceptance.accept).not.toHaveBeenCalled();
  });
  it("waits for the original capacity-refusal release instead of racing its continuation",async()=>{
    const f=fixture();Object.assign(f.native,{accepted:null,inputRefusal:{kind:"recipient"}});
    f.store.sharedAcceptance.query.mockResolvedValue(null as any);
    await expect(f.owner.retire(f.use)).resolves.toBe("pending");expect(f.store.sharedAcceptance.accept).not.toHaveBeenCalled();
  });
  it("does not retire an auxiliary method's input through the task owner",async()=>{
    const f=fixture();Object.assign(f.native.activity.scope,{purpose:{id:"method",revision:"1"}});
    await expect(f.owner.retire(f.use)).resolves.toBe("pending");expect(f.store.sharedAcceptance.accept).not.toHaveBeenCalled();
  });
  it("does not acquire a new receipt or change a previous retirement basis after interruption",async()=>{
    const f=fixture();Object.assign(f.use,{retired:"original-retirement"});
    await f.owner.retire(f.use);
    expect(f.store.protocolJournal.command).not.toHaveBeenCalled();
    expect(f.store.sharedAcceptance.accept).toHaveBeenCalledWith(expect.objectContaining({parts:[
      {owner:"material_custody",kind:"holds",proposal:{acquire:[],release:["input-hold"],basis:"original-retirement"}}]}));
  });
  it("rejects a changed original input before releasing any protection",async()=>{
    const f=fixture();Object.assign(f.native,{contextInput:{id:"input",digest:"changed"}});
    await expect(f.owner.retire(f.use)).rejects.toThrow("original_changed");expect(f.store.sharedAcceptance.accept).not.toHaveBeenCalled();
  });
  it("leaves an already discharged hold's original basis untouched",async()=>{
    const f=fixture();Object.assign(f.use,{retired:"original-retirement",liveHoldIds:[]});
    await expect(f.owner.retire(f.use)).resolves.toBe("retired");
    expect(f.store.sharedAcceptance.accept).not.toHaveBeenCalled();
    expect(f.store.protocolJournal.command).not.toHaveBeenCalled();
  });
  it("rejects a live hold outside the original input responsibility",async()=>{
    const f=fixture();Object.assign(f.use,{liveHoldIds:["another-consumer"]});
    await expect(f.owner.retire(f.use)).rejects.toThrow("live_hold_changed");
    expect(f.store.sharedAcceptance.accept).not.toHaveBeenCalled();
  });
});

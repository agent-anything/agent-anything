import {describe,it,expect,vi} from "vitest";
import {HelarcNativeReportDelivery} from "./HelarcNativeReportDelivery.js";
import type {HelarcExecutionStore} from "../execution-storage/HelarcExecutionStore.js";

describe("native report cancellation disposition",()=>{
  function fixture(){
    const state={obligation:{recipient:{runId:"parent",recipient:"agent",purpose:"task"}},discharged:[],protection:{basis:{id:"original"}}};
    const execution={cancelled:true,accepted:null,activity:{scope:{runId:"parent",recipientId:"agent",purpose:{id:"task"}},
      composition:{composition:{adapter:{implementation:{id:"native-owner"}}}}}};
    const handoff={receiver:"native-owner",disposition:{outcome:"unresolved"}};
    const accept=vi.fn(),query=vi.fn(async(c:any)=>c.kind==="obligation"?state:null);
    const store={materialDeliveries:{query},protocolJournal:{command:vi.fn(async(c:any)=>c.kind==="state"?execution:handoff)},
      sharedAcceptance:{accept,query:vi.fn(async()=>null)},materialCustody:{command:vi.fn()}};
    return {state,execution,handoff,store,delivery:new HelarcNativeReportDelivery(store as unknown as HelarcExecutionStore)};
  }
  it("retains an unknown selected delivery without fabricating receipt or clearing protection",async()=>{
    const f=fixture(),before=structuredClone(f.state);
    await expect(f.delivery.reconcileCancellation({id:"report",revision:"1"},"original","follow-up")).resolves.toBe("unresolved");
    expect(f.state).toEqual(before);expect(f.store.sharedAcceptance.accept).not.toHaveBeenCalled();expect(f.store.materialCustody.command).not.toHaveBeenCalled();
  });
  it.each(["run","recipient","purpose","owner","uncancelled"])("rejects a changed %s before disposition",async field=>{
    const f=fixture();
    if(field==="run")f.execution.activity.scope.runId="sibling";
    if(field==="recipient")f.execution.activity.scope.recipientId="other";
    if(field==="purpose")f.execution.activity.scope.purpose.id="check";
    if(field==="owner")f.handoff.receiver="other";
    if(field==="uncancelled")f.execution.cancelled=false;
    await expect(f.delivery.reconcileCancellation({id:"report",revision:"1"},"original","follow-up")).rejects.toThrow("reconciliation_unconfirmed");
    expect(f.store.sharedAcceptance.accept).not.toHaveBeenCalled();
  });
  it("does not replace an accepted purpose receipt with non-delivery",async()=>{
    const f=fixture();f.execution.accepted={id:"accepted",revision:"1"} as never;
    await expect(f.delivery.reconcileCancellation({id:"report",revision:"1"},"original","follow-up")).rejects.toThrow("original_receipt_required");
    expect(f.store.sharedAcceptance.accept).not.toHaveBeenCalled();
  });
});

import {describe,expect,it} from "vitest";
import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {reportRecipientAdmission} from "./ReportRecipientAdmission.js";

describe("report detail admission fence",()=>{
  function setup(){
    const child={runId:"child",recipient:"worker",purpose:"decision"},parent={...child,runId:"parent"};
    const version={materialId:"report",version:"v1"},pathId="report:publication:"+digest(child),accessId="report:parent:"+digest(parent);
    const controls={runId:"parent",revision:1,commitId:"current",terminal:false,cancelled:false};
    const evidence={id:pathId+":capture-authority",sourceId:pathId+":report-owner",
      ref:{owner:"helarc.report-handoff",kind:"accepted_report_capture",id:accessId,revision:"exact"},
      handoff:{pathId,child,parent,version}};
    const fence=reportRecipientAdmission(()=>controls,id=>id===evidence.id?evidence:null,()=>{throw new Error("unexpected withdrawal");});
    const part={owner:"report_recipient",kind:"require_open",proposal:{pathId,accessId,recipient:parent}};
    const source={recipient:child,range:{...version}};
    const shared={scope:parent.runId,actor:"helarc.report-handoff",id:accessId,parts:[part,{owner:"material_custody",kind:"admit_access",
      proposal:{source,grant:{id:accessId+":grant",recipient:parent}}}]};
    return {controls,source,apply:()=>{const prepared=fence.prepare(part,shared);return ()=>fence.apply(prepared,shared);}};
  }
  it.each(["terminal","cancelled"] as const)("observes recipient %s after preparation but before the grant commits",key=>{
    const s=setup(),commit=s.apply();s.controls[key]=true;
    expect(commit).toThrow("report_recipient_closed");
  });
  it("rejects exchange of the material version even with the right grant identity",()=>{
    const s=setup();s.source.range.version="v2";expect(s.apply()).toThrow("report_access_admission_scope_invalid");
  });
});

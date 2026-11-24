const assert=require("node:assert/strict");
const rootPrompt="HOST_ROOT: Write once.txt with ORIGINAL. Delegate HOST_CHILD_ALPHA for 7391 and HOST_CHILD_BETA for a long synthetic report independently. Search and read DETAIL_CODE in Beta's retained report, then report both results and the exact detail. No other work.";
const followupPrompt="HOST_FOLLOWUP: Report the prior results and DETAIL_CODE without repeating old calls.";
const report="Beta result: 8422; synthetic measurements remain unverified.\n"+
  "Detailed synthetic record, not independently verified.\n".repeat(1100)+"DETAIL_CODE 6843; end of original report.";

// Fixed facts for the controlled peer; actual delegation, custody and detail access remain in the application.
function calls(body){
  const items=body.input??body.messages,text=JSON.stringify(items);
  if(text.includes("HOST_FOLLOWUP")){
    assert(text.includes("6843"));return [{name:"final_result",values:{response:"Root received 7391 and 8422; DETAIL_CODE is 6843; measurements remain unverified."}}];
  }
  if(!text.includes("HOST_ROOT")){
    if(text.includes("HOST_CHILD_ALPHA")){
      assert(!text.includes("HOST_CHILD_BETA"));return [{name:"final_result",values:{response:"Child result 7391"}}];
    }
    assert(text.includes("HOST_CHILD_BETA"));assert(!text.includes("HOST_CHILD_ALPHA"));
    return [{name:"final_result",values:{response:report}}];
  }
  const results=items.filter(i=>i.type==="function_call_output"||i.role==="tool").map(i=>JSON.parse(i.output??i.content));
  if(!results.length)return [{name:"Write",values:{file_path:"once.txt",content:"ORIGINAL"}}];
  if(results.length===1)return [
    {name:"Agent",values:{description:"Alpha report",prompt:"HOST_CHILD_ALPHA: Report 7391 with final_result. No tools or children."}},
    {name:"Agent",values:{description:"Beta report",prompt:"HOST_CHILD_BETA: Return the long synthetic report with DETAIL_CODE using final_result. No tools or children."}},
  ];
  const retained=results.find(r=>r.result?.output?.report)?.result.output.report;
  assert.equal(retained?.status,"retained_material");assert(text.includes("Child result 7391"));
  assert(!text.includes("Detailed synthetic record"),"The retained reference must not inline the full Child report");
  const search=results.find(r=>r.result?.output?.matches)?.result.output;
  const read=results.find(r=>r.result?.output?.coordinate==="utf8_view_bytes")?.result.output;
  if(!search)return [{name:"ContextMaterialSearch",values:{references:[retained.reference],query:"DETAIL_CODE",limit:1}}];
  assert.equal(search.matches.length,1);
  const expected=Buffer.byteLength(report.slice(0,report.lastIndexOf("DETAIL_CODE")));
  assert.equal(search.matches[0].byteStart,expected);
  if(!read)return [{name:"ContextMaterialRead",values:{reference:retained.reference,offset:expected,length:256}}];
  assert.equal(read.byteStart,expected);assert(read.text.includes("6843"));
  return [{name:"final_result",values:{response:"Root received 7391 and 8422; DETAIL_CODE is 6843; measurements remain unverified."}}];
}
module.exports={rootPrompt,followupPrompt,report,calls};

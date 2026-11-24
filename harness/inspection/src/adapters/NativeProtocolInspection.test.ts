import {describe,it,expect} from "vitest";
import {nativeInspectionRecords,supportsNativeInspection,type NativeInspectionBinding} from "./NativeProtocolInspection.js";
const subject={sourceId:"s",datasetId:"d",owner:"protocol-execution",kind:"model-activity" as const,id:"a",runId:"root",revision:null};
const binding:NativeInspectionBinding={subject,protocol:{id:"openai.responses",revision:"1"},interpretation:{id:"openai.responses.adapter",revision:"1"}};
const capture=(value:unknown,category="observation")=>({identity:"fact",operationId:"operation",occurredAt:null,origin:"live" as const,source:subject,value,category});
describe("Read-only native inspection",()=>{
  it("does not equate configured assurance, accepted arrangement and observed conversion",()=>{
    const accepted=[...nativeInspectionRecords(binding,capture({compactionAgreement:{id:"agreement",quality:{allowed:true},
      useEvidence:{id:"eligibility",allowed:true,profileId:"joint-profile",use:{enabled:true,policy:{origin:"provider_documentation"}}}}},"selected_input"))];
    const admission=accepted.find(r=>r.payload.kind==="native_fact"&&r.payload.nativeType==="In-request compaction use admission")!;
    expect(admission.payload).toMatchObject({status:"agreement_accepted",details:expect.arrayContaining([
      {name:"evidenceKind",value:"provider_documentation"},{name:"actualConversionObserved",value:"false"}])});
    expect(admission.links?.some(l=>l.to.id==="eligibility"&&l.to.owner==="helarc-native-input")).toBe(true);
    const observed=[...nativeInspectionRecords(binding,capture({object:"response",id:"response",output:[{type:"compaction",id:"opaque",encrypted_content:"opaque-body"}]}))];
    const conversion=observed.find(r=>r.payload.kind==="native_fact"&&r.payload.nativeType==="Observed in-request compaction item")!;
    expect(conversion.contents?.[0]?.value).toMatchObject({actualConversionObserved:true,internalSourceCoverage:"unknown",
      semanticPreservation:"not_established_by_observation",purposeAccepted:"not_implied"});
    const standalone=[...nativeInspectionRecords(binding,capture({object:"response.compaction",id:"compact-resource",output:[{type:"compaction",id:"opaque",encrypted_content:"opaque-body"}]}))];
    expect(standalone.some(r=>r.payload.kind==="native_fact"&&r.payload.nativeType==="Observed in-request compaction item")).toBe(false);
  });
  it("links input-use settlement to its original native basis without presenting a delivery receipt",()=>{
    const value={input:{id:"selected-input",digest:"input-digest"},basis:{id:"disposition",revision:"1"},acceptanceId:"settlement",received:false};
    const records=[...nativeInspectionRecords(binding,capture(value,"input_use_settled"))];
    expect(records).toHaveLength(1);
    expect(records[0]?.contents?.[0]?.value).toEqual(value);
    expect(records[0]?.payload).toMatchObject({category:"retirement"});
    expect(JSON.stringify(records)).not.toContain('"category":"delivery"');
  });
  it("shows count allowance separately from the measured input and links only recorded ownership",()=>{
    const records=[...nativeInspectionRecords(binding,capture({format:"helarc.responses-count-request.v1",inputId:"input",
      generationDigest:"generation",sourceDigest:"source",allowance:{kind:"auxiliary_input",stageId:"prepare-input",sourcePathId:"input-path"},
      prepared:{body:{model:"model",input:[]}},connection:{credential:"PRIVATE"}},"prepared"))];
    const allowance=records.find(r=>r.contents?.some(c=>c.name==="Original measurement allowance"));
    expect(allowance?.links?.map(link=>link.from)).toEqual(expect.arrayContaining([
      expect.objectContaining({owner:"activity",kind:"contribution",id:"prepare-input"}),
      expect.objectContaining({owner:"activity-resource",kind:"contribution",id:JSON.stringify(["input-path","measurementCalls"])})]));
    expect(JSON.stringify(records)).not.toContain("PRIVATE");
  });
  it("shows compact request and source duties without exporting its connection custody",()=>{
    const records=[...nativeInspectionRecords(binding,capture({format:"helarc.responses-compact-request.v1",
      activity:{scope:{purpose:{id:"compact",revision:"1"}}},connection:{pin:"PRIVATE"},
      binding:{id:"compact",target:"PRIVATE",prepared:{encoded:JSON.stringify({model:"original",input:[{role:"user",content:"historical fact"}]})}},
      source:{sourceDigest:"source",duties:[{id:"duty"}],groups:[{id:"source"}]}},"prepared"))];
    expect(records.find(r=>r.payload.kind==="native_fact"&&r.payload.category==="input")?.contents?.[0]?.value)
      .toEqual({model:"original",input:[{role:"user",content:"historical fact"}]});
    expect(records.find(r=>r.payload.kind==="native_fact"&&r.payload.category==="transformation")?.contents?.[0]?.value)
      .toMatchObject({duties:[{id:"duty"}],groups:[{id:"source"}]});
    expect(JSON.stringify(records)).not.toContain("PRIVATE");
  });
  it("preserves native Items and pointer identity without inventing turns or accounting totals",()=>{
    const records=[...nativeInspectionRecords(binding,capture({id:"response",object:"response",status:"completed",previous_response_id:"previous",
      output:[{id:"a",type:"message",content:[{type:"output_text",text:"same"}]},{id:"b",type:"web_search_call",status:"completed"}],usage:{input_tokens:5}}))];
    expect(records.filter(r=>r.payload.kind==="native_fact"&&r.payload.category==="output").map(r=>r.payload)).toMatchObject([
      {nativeType:"message",nativeId:"a",position:"/output/0"},{nativeType:"web_search_call",nativeId:"b",position:"/output/1"}]);
    expect(JSON.stringify(records)).not.toContain('"kind":"turn"');
    expect(records.find(r=>r.payload.kind==="native_fact"&&r.payload.category==="accounting")?.contents?.[0]?.value).toEqual({input_tokens:5});
  });
  it("uses original interpretation revision and excludes private preparation custody even when unknown",()=>{
    const unknown={...binding,interpretation:{...binding.interpretation,revision:"future"}};
    expect(supportsNativeInspection(unknown)).toBe(false);
    const records=[...nativeInspectionRecords(unknown,capture({wire:{body:'{"input":[]}'},responsesTransport:{connection:"PRIVATE"},binding:{requestId:"q"}},"prepared"))];
    expect(JSON.stringify(records)).not.toContain("PRIVATE");
    expect(records.every(r=>r.payload.kind==="native_fact"&&r.payload.limitation==="native_reader_unavailable")).toBe(true);
    expect(records.some(r=>r.contents?.[0]?.name==="Prepared native input")).toBe(true);
  });
  it("retains protocol-specific output and explicit missing capture",()=>{
    const deep={...binding,protocol:{id:"deepseek.chat-completions",revision:"1"},interpretation:{id:"deepseek.chat-completions.adapter",revision:"1"}};
    expect([...nativeInspectionRecords(deep,capture({choices:[{index:0,message:{content:"hello"},finish_reason:"stop"}]}))]
      .some(r=>r.payload.kind==="native_fact"&&r.payload.nativeType==="choice")).toBe(true);
    const missing=[...nativeInspectionRecords(binding,{...capture(null),unavailableReason:"capture_disabled"})];
    expect(missing[0]?.contents?.[0]?.unavailableReason).toBe("capture_disabled");
  });
  it("keeps complete selected input, outgoing suffix and continuity evidence distinct",()=>{
    const full={input:[{role:"user",content:"Original objective"},{role:"assistant",content:"Earlier reply"},{role:"user",content:"New fact"}]};
    const suffix={previous_response_id:"response-before",input:[full.input[2]]};
    const selected=[...nativeInspectionRecords(binding,capture({manifest:full,prefixGroups:2,predecessor:"response-before",
      continuity:{coverage:"locally_known"},compactionAgreement:{id:"agreement",assurance:"opaque"}},"selected_input"))];
    const prepared=[...nativeInspectionRecords(binding,capture({selectedInputId:"selection",wire:{body:JSON.stringify(suffix)},
      delivery:{selectionId:"selection",sourceIds:["original","reply","new"]},responsesTransport:{credential:"PRIVATE"}},"prepared"))];
    const content=(records:typeof selected,name:string)=>records.flatMap(r=>r.contents??[]).find(c=>c.name===name)?.value;
    expect(content(selected,"Complete selected input")).toEqual(full);
    expect(content(prepared,"Prepared native input")).toEqual(suffix);
    expect(content(selected,"Selected continuity evidence")).toMatchObject({prefixGroups:2,predecessor:"response-before",continuity:{coverage:"locally_known"}});
    expect(content(prepared,"Input continuity boundary")).toMatchObject({remotePrefix:"not established by the outgoing suffix"});
    expect(selected.some(r=>r.payload.kind==="native_fact"&&r.payload.category==="transformation")).toBe(true);
    expect(JSON.stringify(prepared)).not.toContain("PRIVATE");
  });
  it("captures the actual dispatch body without copying connection credentials or headers",()=>{
    const records=[...nativeInspectionRecords(binding,capture({kind:"dispatch",operation:"create",method:"POST",
      url:"https://username:PRIVATE@example.test/v1/responses?key=PRIVATE#PRIVATE",headers:{Authorization:"PRIVATE"},
      body:JSON.stringify({input:[],tools:[]})}))];
    expect(records[0]?.contents?.[0]?.value).toEqual({operation:"create",method:"POST",endpoint:"https://example.test/v1/responses",
      body:{input:[],tools:[]},startingAfter:null});
    expect(JSON.stringify(records)).not.toContain("PRIVATE");
  });
  it("preserves received Ollama metrics without inventing absent usage or a Responses lifecycle",()=>{
    const ollama={...binding,protocol:{id:"ollama.chat",revision:"1"},interpretation:{id:"ollama.chat.adapter",revision:"1"}};
    const records=[...nativeInspectionRecords(ollama,capture({message:{role:"assistant",content:"reply",thinking:"returned reasoning"},
      done:true,done_reason:"stop",eval_count:12}))];
    expect(records.find(r=>r.payload.kind==="native_fact"&&r.payload.category==="output")?.contents?.[0]?.value)
      .toEqual({role:"assistant",content:"reply",thinking:"returned reasoning"});
    expect(records.find(r=>r.payload.kind==="native_fact"&&r.payload.category==="accounting")?.contents?.[0]?.value)
      .toEqual({done:true,done_reason:"stop",eval_count:12});
    expect(JSON.stringify(records)).not.toContain("previous_response_id");
  });
});

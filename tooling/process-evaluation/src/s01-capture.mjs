import {readFile, writeFile, readdir} from "node:fs/promises";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import {InspectionQueryService} from "@agent-anything/inspection/query";

const directory = process.argv[2];
if (!directory) throw new Error("S01 directory required");
const hash = text => createHash("sha256").update(text).digest("hex");
const read = name => readFile(join(directory, name), "utf8");
const save = (name, value) => writeFile(join(directory, name), JSON.stringify(value, null, 2));
const query = new InspectionQueryService(join(directory, "inspection"));
const recordings = [], records = [], encoded = [], performanceSamples=[];
async function retainedText(record,descriptor){
  const selection=recordings.find(item=>item.selection.datasetId===record.subject.datasetId).selection;
  let offset=0,text="";
  do{
    const result=await query.query({...selection,kind:"get_content",contentId:descriptor.id,offset,length:65536});
    if(!result.content)throw new Error("Missing retained content");
    text+=result.content.text;offset=result.content.nextOffset;
    if(text.length>16000000)throw new Error("S01 content capture bound");
  }while(offset!==null);
  return text;
}
try {
  const sources = await query.query({kind: "list_sources"});
  for (const source of sources.sources) {
    let after;
    do {
      const datasets = await query.query({kind: "list_datasets", sourceId: source.sourceId, ...(after ? {after} : {})});
      for (const dataset of datasets.datasets) {
        const snapshot = await query.query({kind: "get_snapshot", sourceId: source.sourceId, datasetId: dataset.datasetId});
        let cursor, count = 0;
        do {
          const page = await query.query({...snapshot.selection, kind: "list_records", limit: 500, ...(cursor ? {after: cursor} : {})});
          records.push(...page.records); count += page.records.length; cursor = page.next;
          if (records.length > 100000) throw new Error("S01 capture record bound");
        } while (cursor);
        recordings.push({selection: snapshot.selection, coverage: snapshot.coverage, records: count, limitations: snapshot.limitations});
      }
      after = datasets.next;
    } while (after);
  }
  for (const record of records) {
    if(record.payload.kind==="event"&&record.payload.name==="execution.performance_batch"){
      const descriptor=record.contents.find(item=>item.name==="Execution performance and correlation");
      if(!descriptor)throw new Error("Missing performance batch");
      performanceSamples.push(...JSON.parse(await retainedText(record,descriptor)).samples);
    }
    for (const descriptor of record.contents.filter(item => ["Encoded request body", "Encoded model input"].includes(item.name))) {
      const text=await retainedText(record,descriptor);
      encoded.push({recordId: record.id, subject: record.subject, descriptor, rawDigest: hash(text), value: JSON.parse(text)});
    }
  }
  await save("inspection-all-records.json", records);
  await save("inspection-all-boundaries.json", recordings);
  await save("inspection-encoded-requests.json", encoded);
  const files = (await readdir(directory)).filter(name => /^request-\d+\.json$/.test(name)).sort();
  const transport = (await read("provider.jsonl")).trim().split("\n").filter(Boolean).map(JSON.parse);
  const requests = [];
  for (const file of files) {
    const raw = await read(file), body = JSON.parse(raw), response = JSON.parse(await read(file.replace(".json", "-response.json")));
    const number = Number(file.match(/\d+/)[0]);
    requests.push({file, round: transport.find(event => event.kind === "request" && event.number === number)?.round,
      bytes: Buffer.byteLength(raw), digest: hash(raw), inspectorMatches: encoded.filter(e => e.rawDigest === hash(raw)).map(e => e.recordId),
      roles: body.messages.map(m => m.role), systemMessages: body.messages.filter(m => m.role === "system").length,
      tools: body.tools.map(tool => tool.function.name), messages: body.messages,
      response, counts: {input: response.prompt_eval_count ?? null, cached: response.prompt_eval_cached_count ?? null, output: response.eval_count ?? null}});
  }
  const normalizeAssistant = message => ({role: message.role, content: message.content ?? "",
    calls: (message.tool_calls ?? []).map(call => ({name: call.function.name, arguments: call.function.arguments}))});
  const continuity = requests.map((request, index) => {
    const previous = requests[index - 1];
    if (!previous) return {file: request.file, kind: "run_opening"};
    const assistant = request.messages[previous.messages.length];
    return {file: request.file, kind: previous.round === request.round ? "same_run" : "conversation_handoff", previousMessagesPreserved:
      JSON.stringify(request.messages.slice(0, previous.messages.length)) === JSON.stringify(previous.messages),
    previousAssistantPreserved: !!assistant && isDeepStrictEqual(normalizeAssistant(assistant),
      normalizeAssistant(previous.response.message))};
  });
  const expectation = JSON.parse(await read("expectation.json"));
  const exchanges = requests.map(request => {
    let pending = 0, closed = true;
    for (const message of request.messages) {
      if (message.role === "tool") {
        if (pending === 0) closed = false;
        else pending--;
      } else {
        if (pending !== 0) closed = false;
        pending = (message.tool_calls ?? []).length;
      }
    }
    const userText = request.messages.filter(m => m.role === "user").map(m => m.content).join("\n");
    return {file: request.file, nativeExchangeGroupsClosed: closed && pending === 0,
      originalAssignmentOccurrences: userText.split(expectation.initial).length - 1,
      correctionOccurrences: userText.split(expectation.correction).length - 1};
  });
  await save("request-continuity.json", continuity);
  await save("request-exchanges.json", exchanges);
  await save("request-audit.json", requests);
  const local=(await read("performance.jsonl")).trim().split("\n").filter(Boolean).map(JSON.parse);
  const selected=local.filter(event=>event.kind==="finished"&&
    ["storage.host.request","storage.worker.command","storage.host.startup","storage.worker.entry","storage.worker.load_database","storage.worker.open_database"].includes(event.stage));
  const originalById=new Map(selected.map(event=>[event.id,event])),capturedById=new Map(performanceSamples.map(event=>[event.id,event]));
  const performanceAudit={selected:selected.length,captured:performanceSamples.length,duplicates:performanceSamples.length-capturedById.size,
    missing:selected.filter(event=>!capturedById.has(event.id)).map(event=>({id:event.id,stage:event.stage,context:event.context})),
    invented:performanceSamples.filter(event=>!originalById.has(event.id)).map(event=>event.id),
    changed:performanceSamples.filter(event=>{const original=originalById.get(event.id);return original&&(!isDeepStrictEqual(event.counters??{},original.counters??{})||event.durationMs!==original.durationMs||event.context.requestId!==original.context.requestId);}).map(event=>event.id)};
  await save("performance-audit.json",performanceAudit);
  console.log(JSON.stringify({recordings: recordings.map(item => ({selection: item.selection, records: item.records,
    coverage: item.coverage, limitations: item.limitations})), requests: requests.map(({messages, response, tools, ...rest}) => ({...rest,
    toolCount: tools.length, responseCalls: response.message?.tool_calls?.map(call => call.function.name) ?? [],
    textLength: response.message?.content?.length ?? 0})), encoded: encoded.length, continuity, exchanges,performanceAudit}, null, 2));
} finally {await query.close();}

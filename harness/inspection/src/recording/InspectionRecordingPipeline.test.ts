import {afterEach, expect, it} from "vitest";
import Database from "better-sqlite3";
import {mkdtempSync, rmSync, readdirSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, relative, resolve} from "node:path";
import {InspectionRecorder} from "../../dist/recording/InspectionRecorder.js";
import {InspectionDatabase} from "../../dist/storage/InspectionDatabase.js";
import {datasetDirectory} from "../sources/index.js";
import {DEFAULT_INSPECTION_CAPTURE_POLICY} from "../content/index.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {for (const dispose of cleanup.splice(0).reverse()) await dispose();});
async function setup() {
  const root = mkdtempSync(join(tmpdir(), "inspection-pipeline-"));
  cleanup.push(async () => {if (!relative(tmpdir(), resolve(root)).startsWith("inspection-pipeline-")) throw new Error("Unsafe cleanup"); rmSync(root, {recursive: true, force: true});});
  const recorder = await InspectionRecorder.create({root, application: "pipeline-test", name: "Test", policy: {...DEFAULT_INSPECTION_CAPTURE_POLICY, agent: true}});
  cleanup.push(() => recorder.flush(true));
  const directory = datasetDirectory(root, recorder.source.sourceId, recorder.manifest.datasetId);
  const ref = recorder.ref("runtime", "run", "run", "run");
  const offer = (id: string, text?: string) => recorder.offer({id, subject: ref, occurredAt: null, payload: {kind: "event", name: "fact", sequence: null, code: null},
    ...(text === undefined ? {} : {contents: [{name: "body", class: "agent", stage: "result", mediaType: "text/plain", value: text}]})});
  return {root, recorder, directory, ref, offer};
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

it.each(["count","content"] as const)("reserves live headroom under %s pressure across replay producers",async(dimension)=>{
  const {recorder,ref,offer}=await setup();
  const body="x".repeat(1024*1024),count=dimension==="count"?100:24;
  const input=(i:number)=>({id:"pull-"+i,subject:ref,occurredAt:null,payload:{kind:"event" as const,name:"pull",sequence:i,code:null},
    ...(dimension==="count"?{}:{contents:[{name:"body",class:"agent" as const,stage:"result",mediaType:"text/plain" as const,value:body}]})});
  // Until this turn yields to I/O the real worker cannot deliver an acknowledgement.
  for(let i=0;i<count;i++)expect(await recorder.offerWhenReady(input(i))).toBe(true);
  const pending=recorder.offerWhenReady(input(count));
  expect(recorder.health().queued).toBe(count);
  for(let i=0;i<3;i++)expect(offer("live-"+i,dimension==="content"?body:undefined)).toBe(true);
  expect(await pending).toBe(true);
  expect((await recorder.flush()).native).toBe("settled");expect(recorder.health().dropped).toBe(0);
},30000);

it("does not confirm a replay group when SQLite rejects one of its accepted offers",async()=>{
  const {recorder,ref,offer}=await setup();
  await recorder.confirmNativeWork(async()=>{expect(offer("one")).toBe(true);});
  await expect(recorder.confirmNativeWork(async()=>{expect(await recorder.offerWhenReady({id:"one",subject:ref,occurredAt:null,
    payload:{kind:"event",name:"conflicting",sequence:2,code:null}})).toBe(true);})).rejects.toThrow("inspection_replay_record_rejected");
  await recorder.confirmNativeWork(async()=>{expect(offer("unrelated")).toBe(true);});
});

it("persists rejected-input health with no subsequent data batch", async () => {
  const {recorder, directory} = await setup();
  expect(recorder.offer({} as never)).toBe(false);
  await sleep(200);
  const db = new InspectionDatabase(directory);
  try {expect(db.snapshot().recording?.ingress).toMatchObject({accepted: 0, rejected: 1,
    issues: [{reason: "invalid_input", firstSequence: null, samples: [{subject: null}]}]});}
  finally {db.close();}
});

it("attributes pre-admission rejections without storing bodies, invoking accessors or assigning sequences",async()=>{
  const {recorder,ref}=await setup();
  const input={id:"offer-1",subject:ref,occurredAt:null,payload:{kind:"event" as const,name:"fact",sequence:null,code:null}};
  const privateText="private-marker";
  expect(recorder.offer({...input,payload:{...input.payload,name:privateText.repeat(5000)}})).toBe(false);
  expect(recorder.offer({...input,payload:{...input.payload,sequence:-1}})).toBe(false);
  expect(recorder.offer({...input,subject:{...ref,datasetId:"foreign"}})).toBe(false);
  let accessed=false;
  expect(recorder.offer({...input,get subject(){accessed=true;throw Error(privateText);}})).toBe(false);
  expect(accessed).toBe(false);
  // JSON encodes each control character as six ASCII bytes in the final descriptors.
  const wide="\u0001".repeat(256);
  expect(recorder.offer({...input,contents:Array.from({length:32},()=>({name:wide,stage:wide,class:"agent",mediaType:"text/plain",value:null,unavailableReason:wide}))})).toBe(false);
  const {barrier}=await recorder.flush(true);
  expect(barrier.accepted).toBe(0);
  const issues=recorder.health().coverage!.recording!.ingress.issues;
  const samples=issues.flatMap(i=>i.samples.map(s=>({reason:i.reason,...s})));
  const at=(stage:string)=>samples.find(s=>s.validation?.stage===stage);
  expect(at("structure_snapshot")).toMatchObject({reason:"structure_oversized",subject:ref,validation:{recordId:"offer-1",limitBytes:65536}});
  expect(at("fields")).toMatchObject({reason:"invalid_input",subject:ref,validation:{recordId:"offer-1"}});
  for(const s of ["scope","envelope"])expect(at(s)).toMatchObject({subject:null,validation:{recordId:null}});
  expect(at("encoded_record")).toMatchObject({reason:"record_oversized",subject:ref,validation:{recordId:"offer-1",limitBytes:65536}});
  expect(samples.every(s=>s.sequence===null)).toBe(true);
  expect(JSON.stringify(samples)).not.toContain(privateText);
});

it("closes durable native evidence independently of telemetry catch-up",async()=>{
  const {recorder,offer,directory}=await setup();
  for(let i=0;i<1600;i++)offer(`closing-${i}`);
  const deadline=Date.now()+10000;
  while(recorder.health().queued>0){expect(Date.now()).toBeLessThan(deadline);await new Promise(resolve=>setTimeout(resolve,5));}
  const result=await recorder.flush(true);
  expect(result).toMatchObject({native:"settled",unpersisted:0,unconfirmed:0,code:null});
  const db=new InspectionDatabase(directory);
  try{
    const coverage=db.snapshot(),p=coverage.recording!;
    expect(coverage.status).toBe("closed");expect(coverage.captured).toBe(1600);
    expect(result.projection).toBe(p.projection.cursor<p.native.target?"incomplete":"settled");
    if(result.projection==="incomplete")expect(coverage.limitations).toContain("telemetry_projection_incomplete");
    expect(JSON.parse(readFileSync(join(directory,"manifest.json"),"utf8")).status).toBe("closed");
  }finally{db.close();}
});

it("keeps a nonclosing flush barrier fixed while later offers continue", async () => {
  const {recorder, offer} = await setup(); offer("before");
  const flush = recorder.flush();
  for (let index = 0; index < 150; index++) offer(`later-${index}`);
  const result = await flush;
  expect(result.barrier.accepted).toBe(1);
  expect(result.native).toBe("settled");
  expect(result.projection).toBe("settled");
  expect(recorder.health().available).toBe(true);
  expect((await recorder.flush()).native).toBe("settled");
});

it("reports exact count saturation independently of projection omissions", async () => {
  const {recorder, offer, directory} = await setup();
  for (let index = 0; index < 4100; index++) offer(`record-${index}`);
  expect(recorder.health().dropped).toBe(4);
  let result = await recorder.flush();
  for (let retry = 0; result.native === "pending" && retry < 4; retry++) result = await recorder.flush();
  expect(result.native).toBe("settled");
  const db = new InspectionDatabase(directory);
  try {
    expect(db.snapshot().recording?.ingress).toMatchObject({accepted: 4096, dropped: 4,
      issues: [{reason: "record_capacity", count: 4, firstSequence: 4097, lastSequence: 4100}]});
    expect(db.snapshot().captured).toBe(4096);
    expect(db.snapshot().telemetryDropped).toBe(0);
  } finally {db.close();}
});

it("distinguishes content-byte saturation from count saturation", async () => {
  const {recorder, offer, directory} = await setup();
  const body = "x".repeat(1024 * 1024);
  for (let index = 0; index < 34; index++) offer(`large-${index}`, body);
  expect(recorder.health().dropped).toBe(2);
  await recorder.flush();
  const db = new InspectionDatabase(directory);
  try {expect(db.snapshot().recording?.ingress.issues).toMatchObject([{reason: "content_capacity", count: 2}]);}
  finally {db.close();}
});

it("distinguishes structure-byte saturation from count and content limits", async () => {
  const {recorder, directory, ref} = await setup();
  let accepted = 0;
  for (let index = 0; index < 2000; index++) {
    if (recorder.offer({id: `structure-${index}`, subject: ref, occurredAt: null,
      payload: {kind: "event", name: "fact", sequence: index, code: null},
      links: Array.from({length: 24}, (_, link) => ({kind: "binding" as const, from: ref,
        to: recorder.ref("runtime", "event", `${index}-${link}-${"x".repeat(64)}`, "run"),
        condition: null, operation: null, sourceLocation: null, targetLocation: null}))})) accepted++;
  }
  expect(accepted).toBeGreaterThan(0);
  expect(accepted).toBeLessThan(2000);
  let result = await recorder.flush();
  for (let retry = 0; result.native === "pending" && retry < 4; retry++) result = await recorder.flush();
  expect(result.native).toBe("settled");
  const db = new InspectionDatabase(directory);
  try {
    expect(db.snapshot().recording?.ingress.issues).toMatchObject([{reason: "structure_capacity", count: 2000 - accepted}]);
    expect(db.snapshot().captured).toBe(accepted);
  } finally {db.close();}
}, 30_000);

it("retains 25000 durable offers under backpressure with repeated bounded bodies and independent telemetry progress", async () => {
  const {recorder, directory} = await setup();
  const started = performance.now();
  let bodyBytes = 0;
  for (let batch = 0; batch < 250; batch++) {
    for (let index = batch * 100; index < (batch + 1) * 100; index++) {
      const subject = recorder.ref(index % 2 ? "runtime" : "model-interaction", "event", `fact-${index}`, `run-${index % 8}`);
      const text = index % 3 === 0 ? `${index % 18000}:` + "x".repeat(index % 9 === 0 ? 42 * 1024 : 4 * 1024) : null;
      bodyBytes += text?.length ?? 0;
      const accepted = await recorder.offerWhenReady({id: `burst-${index}`, subject, occurredAt: new Date().toISOString(),
        payload: {kind: "event", name: "owner_fact", code: null, sequence: index},
        contents: text === null ? [] : [{name: "body", stage: "received", class: "agent", mediaType: "text/plain", value: text}]});
      expect(accepted, accepted ? undefined : JSON.stringify({index, health: recorder.health()})).toBe(true);
    }
  }
  let result = await recorder.flush();
  for (let retry = 0; (result.native === "pending" || result.projection === "pending") && retry < 10; retry++) result = await recorder.flush();
  expect(result).toMatchObject({native: "settled", projection: "settled", unpersisted: 0, unconfirmed: 0});
  expect(recorder.health()).toMatchObject({available: true, dropped: 0, rejected: 0, queued: 0});
  const db = new InspectionDatabase(directory);
  const raw = new Database(join(directory, "inspection.sqlite"), {readonly: true});
  try {
    const coverage = db.snapshot();
    expect(coverage.captured).toBe(25000);
    expect(coverage.telemetryDropped).toBe(0);
    expect(coverage.recording?.timings?.projectionConversion.count).toBeGreaterThan(0);
    expect(coverage.recording?.timings?.projectionWrite.count).toBeGreaterThan(0);
    expect(coverage.recording!.projection.sliceMaxMs).toBeGreaterThanOrEqual(coverage.recording!.timings!.projectionWrite.maxMs);
    expect(raw.prepare("SELECT COUNT(*) n FROM contents WHERE body_id IS NULL").get()).toEqual({n: 0});
    expect(raw.prepare("SELECT COUNT(*) n FROM batch_receipts").get()).toEqual({n: 250});
    expect(readdirSync(directory).some(name => name === "content" || name === "staging")).toBe(false);
    console.log("Inspection representative burst", {records: coverage.captured, offeredBodyBytes: bodyBytes,
      elapsedMs: Math.round(performance.now() - started), databaseBytes: db.size(), progress: coverage.recording});
  } finally {raw.close(); db.close();}
}, 60_000);

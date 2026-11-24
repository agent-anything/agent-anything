import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { unpackExecutionContent } from "../dist/main/execution-storage/ExecutionContent.js";
import factsModule from "./fixtures/retained-protocol-facts.cjs";

// Prepare both independent archives and their expected facts before starting any application.
const [generic, generate] = process.argv.slice(2);
assert(generic && generate && process.argv.length === 4, "expected two retained synthetic fixture directories");
const tmp = realpathSync(tmpdir()), kit = mkdtempSync(join(tmp, "helarc-retained-protocols-"));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const json = path => JSON.parse(readFileSync(path, "utf8"));
const open = path => new DatabaseSync(path, { readOnly: true });

async function snapshot(source, destination) {
  const db = open(source);
  try { await backup(db, destination); } finally { db.close(); }
}
async function prepare(kind, source) {
  const src = realpathSync(resolve(source)), rel = relative(tmp, src).split(sep).join("/");
  assert((kind === "generic" ? /^helarc-electron-recovery-[\w]+\/continued_child$/ : /^helarc-representation-method-[\w]+$/).test(rel),
    "only the retained synthetic test families are eligible");
  const dir = join(kit, kind);
  mkdirSync(join(dir, "execution"), { recursive: true });
  await snapshot(join(src, "execution/execution.sqlite"), join(dir, "execution/execution.sqlite"));
  const db = open(join(dir, "execution/execution.sqlite"));
  let original;
  try {
    const stmt = db.prepare("SELECT id,value AS text FROM execution_content WHERE id=?");
    const unpack = ref => unpackExecutionContent(JSON.parse(ref), id => stmt.get(id));
    if (kind === "generic") {
      const root = json(join(src,"seed.json")).rootRunId;
      const row = db.prepare("SELECT value,delivered FROM product_admissions WHERE root_run_id=?").get(root);
      assert(row && !row.delivered);
      const a = unpack(row.value);
      assert(a.version === 3 && a.providerProfile.providerKind === "openai-compatible" && a.providerCredential.kind === "none");
      assert.equal(a.providerBinding.descriptor.id,"openai-compatible.chat-completions");
      const requestId = JSON.parse(readFileSync(join(src,"seed-provider-requests.jsonl"),"utf8").trimStart().split("\n",1)[0]).requestId;
      const witness = join(src,"workspace/executions.txt");
      assert(readFileSync(witness).length > 0);
      original = { root, requestId, owner: a.providerBinding.descriptor.id, witness: hash(readFileSync(witness)) };
    } else {
      const physical = json(join(src,"physical-requests.json"));
      assert.deepEqual(physical.methodJobs, ["generate","check"]);
      const stages = db.prepare("SELECT id,request,result_id,receipt_id FROM activity_stages WHERE status='accepted' ORDER BY rowid").all()
        .map(s => ({ ...s, req: unpack(s.request) })).filter(s => s.req.stageKind === "model");
      assert.equal(stages.length, 2);
      const jobs = stages.map((s,i) => {
        const {encoded,request} = s.req.input;
        assert.equal(new URL(encoded.endpoint).pathname, "/api/generate");
        assert(typeof physical.bodies[i].prompt === "string" && !Object.hasOwn(physical.bodies[i],"messages"));
        assert.deepEqual(JSON.parse(encoded.body), physical.bodies[i]);
        assert(s.result_id && s.receipt_id);
        return { id:s.id, path:s.req.pathId, result:s.result_id, receipt:s.receipt_id, requestId:request.requestId, body:hash(encoded.body) };
      });
      original = { root:"parent", requestId:jobs[0].requestId, jobs };
    }
    original.version = db.prepare("SELECT version FROM store").get().version;
    original.rows = factsModule.facts(db);
  } finally { db.close(); }
  const archive=join(src,"inspection");
  const names=readdirSync(archive,{recursive:true}).filter(n=>n.endsWith("inspection.sqlite"));
  assert.equal(names.length,1);
  const from=join(archive,names[0]),to=join(dir,"inspection",names[0]); mkdirSync(dirname(to),{recursive:true});
  await snapshot(from,to);
  for(const f of readdirSync(archive,{recursive:true}).filter(n=>["source.json","read-policy.json","manifest.json"].includes(n.split(sep).at(-1))))
    copyFileSync(join(archive,f),join(dir,"inspection",f));
  const capture = open(to);
  try {
    const rows = capture.prepare("SELECT value FROM records WHERE owner='model-interaction' AND subject_kind='request' AND run_id=? ORDER BY sequence").iterate(original.root);
    let recorded;
    for(const row of rows){const r=JSON.parse(row.value);if(r.subject.id===original.requestId){recorded=r;break;}}
    assert(recorded,"original model request must have a captured subject");
    original.inspection={subject:recorded.subject,id:recorded.id,watermark:capture.prepare("SELECT watermark FROM dataset").get().watermark,
      payload:hash(JSON.stringify(recorded.payload)),database:names[0]};
  } finally { capture.close(); }
  return { kind, source:rel, ...original };
}
console.log("Isolated case kit:",kit);
const cases = [await prepare("generic",generic),await prepare("generate",generate)];
for(const f of ["main/execution-storage/ExecutionStoreWorker.js","main/run/HelarcHostRunRecovery.js","main/provider/HelarcRunProviderBinding.js",
  "main/context/HelarcRepresentationMethods.js"]) assert(existsSync(new URL("../dist/"+f,import.meta.url)), "missing built participant: "+f);
writeFileSync(join(kit,"prepared.json"),JSON.stringify({format:1,cases},null,2),{flag:"wx"});
console.log("Both execution and inspection samples prepared; no recovery, model dispatch or verification performed.");

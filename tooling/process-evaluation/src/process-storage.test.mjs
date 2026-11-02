import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, mkdir, writeFile, rm} from "node:fs/promises";
import {join, dirname, resolve, basename} from "node:path";
import {tmpdir} from "node:os";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {createProcessStore, readBranchFile} from "./process-storage.mjs";

async function isolated(run) {
  const directory = await mkdtemp(join(tmpdir(), "evaluation-storage-test-"));
  try {await run(directory);}
  finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert(basename(directory).startsWith("evaluation-storage-test-"));
    await rm(directory, {recursive: true, force: true});
  }
}
test("ownership excludes a second coordinator and releases on abrupt process exit", async () => isolated(async directory => {
  const store = await createProcessStore(directory), lease = await store.claim();
  await assert.rejects((await createProcessStore(directory)).claim(), /already_owned/);
  await lease.release();
  const moduleUrl = new URL("./process-storage.mjs", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `import {createProcessStore} from ${JSON.stringify(moduleUrl)};
    const store=await createProcessStore(${JSON.stringify(directory)});await store.claim();process.exit(73);`], {windowsHide: true, stdio: "ignore"});
  const [code] = await once(child, "close"); assert.equal(code, 73);
  await (await store.claim()).release();
}));
test("journal rejects replacement, revision races and altered original bytes", async () => isolated(async directory => {
  const store = await createProcessStore(directory);
  await store.commit(null, {revision: 1, value: "original"});
  await assert.rejects(store.commit(null, {revision: 1, value: "replacement"}), /revision_conflict/);
  await store.commit(1, {revision: 2, value: "accepted"});
  assert.equal((await (await createProcessStore(directory)).load()).value, "accepted");
  await writeFile(join(directory, "revision-1.json"), JSON.stringify({record: {revision: 1, value: "changed"}, digest: "wrong", previous: null}));
  await assert.rejects(store.load(), /integrity_failed/);
}));
test("branch reads enforce scope and declared byte bounds", async () => isolated(async directory => {
  await mkdir(join(directory, "a")); await mkdir(join(directory, "b"));
  await writeFile(join(directory, "a", "body.txt"), "abcd"); await writeFile(join(directory, "b", "body.txt"), "private");
  assert.equal((await readBranchFile(join(directory, "a"), "body.txt", 4)).toString(), "abcd");
  await assert.rejects(readBranchFile(join(directory, "a"), "body.txt", 3), /source_bound/);
  await assert.rejects(readBranchFile(join(directory, "a"), "../b/body.txt"), /cross_branch/);
}));

import {mkdir, readFile, readdir, open, link, unlink, realpath} from "node:fs/promises";
import {join, resolve, relative, isAbsolute} from "node:path";
import {createHash, randomUUID} from "node:crypto";
import {DatabaseSync} from "node:sqlite";

export function digest(value) {return createHash("sha256").update(JSON.stringify(value)).digest("hex");}
export async function writeImmutable(file, value) {
  const temporary = `${file}.${randomUUID()}.pending`;
  const handle = await open(temporary, "wx");
  try {await handle.writeFile(JSON.stringify(value)); await handle.sync();} finally {await handle.close();}
  try {await link(temporary, file);} finally {await unlink(temporary);}
}
export async function createProcessStore(directory) {
  await mkdir(directory, {recursive: true});
  const load = async () => {
    const names = (await readdir(directory)).filter(name => /^revision-\d+\.json$/.test(name)).sort((a,b) => Number(a.slice(9,-5))-Number(b.slice(9,-5)));
    let last = null;
    for (const [index, name] of names.entries()) {
      const item = JSON.parse(await readFile(join(directory, name), "utf8"));
      if (item.record.revision !== index + 1 || item.digest !== digest(item.record) || item.previous !== (last ? digest(last) : null)) throw new Error("process_record_integrity_failed");
      last = item.record;
    }
    return last;
  };
  return {load, async claim() {
    const database = new DatabaseSync(join(directory, "ownership.sqlite"));
    try {database.exec("BEGIN EXCLUSIVE");}
    catch (error) {database.close(); throw new Error("process_trial_already_owned", {cause: error});}
    return {async release() {try {database.exec("ROLLBACK");} finally {database.close();}}};
  }, async commit(expected, record) {
    const previous = await load();
    if ((previous?.revision ?? null) !== expected || record.revision !== (expected ?? 0) + 1) throw new Error("process_record_revision_conflict");
    await writeImmutable(join(directory, `revision-${record.revision}.json`), {record, digest: digest(record), previous: previous ? digest(previous) : null});
  }};
}
export async function readBranchFile(directory, location, maximumBytes = 16777216) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new TypeError("Invalid capture byte bound");
  const root = await realpath(directory), target = await realpath(resolve(root, location));
  const part = relative(root, target);
  if (part === ".." || part.startsWith("..\\") || part.startsWith("../") || isAbsolute(part)) throw new Error("evaluation_cross_branch_access_denied");
  const file = await open(target, "r");
  try {
    const size = (await file.stat()).size;
    if (size > maximumBytes) throw new Error("evaluation_capture_source_bound");
    const value = Buffer.alloc(size + 1);
    let offset = 0;
    for (;;) {
      const {bytesRead} = await file.read(value, offset, value.length - offset, offset);
      if (!bytesRead) return value.subarray(0, offset);
      offset += bytesRead;
      if (offset > size) throw new Error("evaluation_capture_source_changed");
    }
  } finally {await file.close();}
}

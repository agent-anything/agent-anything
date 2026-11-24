import {Session} from "node:inspector/promises";
import {parentPort, threadId} from "node:worker_threads";
import {mkdtemp, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

// Test-only entry: sample the unchanged production Worker, including its imports.
const directory = await mkdtemp(join(tmpdir(), "helarc-worker-cpu-"));
const session = new Session();
session.connect();
await session.post("Profiler.enable");
await session.post("Profiler.start");
parentPort.once("close", async () => {
  try {
    const {profile} = await session.post("Profiler.stop");
    const file = join(directory, `worker-${process.pid}-${threadId}.cpuprofile`);
    await writeFile(file, JSON.stringify(profile));
    process.stdout.write(`Execution Worker CPU profile: ${file}\n`);
  } finally {session.disconnect();}
});
await import("../../dist/main/execution-storage/ExecutionStoreWorker.js");

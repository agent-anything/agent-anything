import {Session} from "node:inspector/promises";
import {mkdtemp,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

/** Opt-in sampling in the actual test process; the test runner may not flush CLI profiles on fork exit. */
export async function startExecutionTestCpuProfile():Promise<(()=>Promise<void>)|null> {
  if(process.env.HELARC_TEST_CPU_PROFILE!=="1")return null;
  const directory=await mkdtemp(join(tmpdir(),"helarc-test-cpu-")),session=new Session();
  session.connect();
  try {await session.post("Profiler.enable");await session.post("Profiler.start");}
  catch(error){session.disconnect();throw error;}
  return async()=>{
    try {
      const {profile}=await session.post("Profiler.stop");
      const file=join(directory,`execution-${process.pid}.cpuprofile`);
      await writeFile(file,JSON.stringify(profile));
      process.stdout.write(`Execution test CPU profile: ${file}\n`);
    } finally {session.disconnect();}
  };
}

import {WindowsJobProcessBackend, resolveWindowsProcessHelper} from "../../../dist/command/WindowsJobProcessBackend.js";
import {dirname, join} from "node:path";
const helper = await resolveWindowsProcessHelper();
const handle = await new WindowsJobProcessBackend(helper).launch({executionId:"host-loss-test",
  executable:join(dirname(helper),"process-fixture.exe"),args:["sleep","60000"],cwd:dirname(helper),
  environment:process.env,signal:new AbortController().signal,startupTimeoutMs:3000},()=>{});
process.send({pid:handle.processId,helperPid:handle.helperProcessId});
setInterval(()=>{},1000);

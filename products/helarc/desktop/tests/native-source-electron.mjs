import {app,BrowserWindow,ipcMain} from "electron";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {HelarcWorkbenchQueries} from "../dist/main/workbench/HelarcWorkbenchQueries.js";
import {CommandOutputRegistry} from "../dist/main/workbench/CommandOutputRegistry.js";
app.setPath("userData",process.env.HELARC_NATIVE_UI_DATA);app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
const {projection:p}=JSON.parse(await readFile(process.env.HELARC_NATIVE_PRODUCT,"utf8"));
p.display={status:"completed",terminal:true,statusSource:"host"};
p.product.runId="product";
const thread={thread:{id:"thread",revision:1},messages:[{id:"user",sequence:1,role:"user",content:"Root assignment",source:{kind:"user_input"},
  correlation:{runId:"product"},metadata:{},relatedArtifactIds:[]}],artifacts:[],runs:[{id:"product",harnessRunId:"root",triggeringMessageId:"user",
  startedAt:"2026-11-16T00:00:00Z",updatedAt:"2026-11-16T00:00:01Z",terminal:null,lastProjection:p}]};
const queries=new HelarcWorkbenchQueries({loadThread:async id=>id==="thread"?thread:null,live:()=>null,outputs:new CommandOutputRegistry()});
ipcMain.handle("native-reading",(_event,method,query)=>{
  if(!["readConversation","readConversationResponseGroup","readWorkbenchItem"].includes(method))throw new Error("Unsupported reading");
  return queries[method](query);
});
const window=new BrowserWindow({width:1440,height:900,show:false,webPreferences:{preload:fileURLToPath(new URL("./native-source-preload.cjs",import.meta.url)),contextIsolation:true,nodeIntegration:false,sandbox:true}});
await window.loadURL(process.env.HELARC_NATIVE_UI_URL);
app.on("window-all-closed",()=>app.quit());
}).catch(error=>{console.error(error);app.exit(1);});

import {helarcProduct} from "@agent-anything/helarc";
import {BrowserWindow,app,dialog} from "electron";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
import {createHelarcApplicationServices} from "./HelarcApplicationServices.js";
import {HelarcExecutionStore} from "./execution-storage/HelarcExecutionStore.js";
import {ElectronSafeStorageCredentialCipher} from "./provider/ElectronSafeStorageCredentialCipher.js";
import {reconcileInterruptedHooks} from "./execution-storage/reconcileInterruptedHooks.js";
import {HelarcExecutionDiagnostics} from "./diagnostics/HelarcExecutionDiagnostics.js";
import {registerHelarcIpc} from "./ipc.js";
import {createHelarcWindowOptions} from "./windowOptions.js";
import {HelarcInspection} from "./inspection/HelarcInspection.js";
import {createHelarcActivityHost} from "./context/HelarcActivityHost.js";
import {closeHelarcHost} from "./context/HelarcHostShutdown.js";

const currentDir=dirname(fileURLToPath(import.meta.url));
let inspection:Promise<HelarcInspection>|null=null;
let executionStore:Promise<HelarcExecutionStore>|null=null;
let diagnostics:HelarcExecutionDiagnostics|null=null;
let activityHost:ReturnType<typeof createHelarcActivityHost>|null=null;
let services:Promise<Awaited<ReturnType<typeof createHelarcApplicationServices>>>|null=null;
let closing=false;

app.on("before-quit",event=>{
  if(!services||closing)return;
  event.preventDefault();closing=true;
  void closeHelarcHost({
    activities:async remaining=>{await services?.catch(()=>{});return activityHost?.service.close(remaining);},
    inspection:async()=>{await inspection?.then(source=>source.close());},
    storage:async()=>{await services?.then(source=>source.close(),()=>{});await executionStore?.then(store=>store.close());},
    diagnostics:async()=>{await diagnostics?.flush();},
  }).then(result=>{
    if(result.incomplete.length||result.failed.length){
      try{console.warn("Helarc shutdown retained unconfirmed work.",result);}catch{/* Closed console does not change execution facts. */}
    }
  }).finally(()=>app.quit());
});

app.whenReady().then(()=>{
  void createWindow().catch(reportWindowCreationFailure);
  app.on("activate",()=>{
    if(!closing&&BrowserWindow.getAllWindows().length===0)void createWindow().catch(reportWindowCreationFailure);
  });
});
app.on("window-all-closed",()=>{if(process.platform!=="darwin")app.quit();});

async function initializeServices(){
  const userDataPath=app.getPath("userData");
  diagnostics=new HelarcExecutionDiagnostics(join(userDataPath,"execution-diagnostics.json"));
  inspection=HelarcInspection.create(join(userDataPath,"inspection-settings.json"));
  const source=await inspection;
  if(closing)throw new Error("Application is closing.");
  executionStore=HelarcExecutionStore.open(join(userDataPath,"execution"),undefined,source.evidenceObserver,
    source.fileMaterialObserver,diagnostics,new ElectronSafeStorageCredentialCipher(),source.contextMaterialObserver,
    source.activityObserver,source.contextFoundationObserver);
  const executions=await executionStore;
  await reconcileInterruptedHooks(executions,record=>source.definitions?.recoveredHook(record));
  if(closing)throw new Error("Application is closing.");
  activityHost=createHelarcActivityHost(executions,{diagnostics});
  return createHelarcApplicationServices({userDataPath,inspection:source,executions,diagnostics,activityHost});
}

async function createWindow():Promise<void>{
  if(closing)return;
  const window=new BrowserWindow(createHelarcWindowOptions(join(currentDir,"../preload/preload.cjs")));
  services??=initializeServices();
  const application=await services;
  if(closing||window.isDestroyed())return;
  registerHelarcIpc({...application,window});
  window.setTitle(helarcProduct.displayName);
  window.once("ready-to-show",()=>window.show());
  const url=readRendererDevServerUrl(process.env);
  if(url)await window.loadURL(url);
  else await window.loadFile(join(currentDir,"../renderer/index.html"));
}

function reportWindowCreationFailure(cause:unknown):void{
  if(closing)return;
  const message=cause instanceof Error?cause.message:"Helarc window creation failed.";
  try{console.error("Helarc window creation failed.",cause);}catch{/* Diagnostic sink may have closed. */}
  dialog.showErrorBox("Helarc failed to start",message);
}

function readRendererDevServerUrl(env:NodeJS.ProcessEnv):string|null{
  const value=env.HELARC_RENDERER_DEV_SERVER_URL?.trim();
  if(!value)return null;
  try{const url=new URL(value);return url.protocol==="http:"||url.protocol==="https:"?url.toString():null;}
  catch{return null;}
}

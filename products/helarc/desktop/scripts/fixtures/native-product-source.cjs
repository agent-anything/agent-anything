const {join}=require("node:path");

module.exports=async function nativeProductSource({directory,store,built,model,taskExecution,materialAccess,reportHandoff,stopEvaluation}){
  const files=await import("@agent-anything/helarc-local-environment/filesystem");
  const commands=await import("@agent-anything/helarc-local-environment/command");
  const tools=await import("@agent-anything/helarc/tools"),h=await import("@agent-anything/helarc/controller");
  const {createHelarcNativeProductComposition}=await import("@agent-anything/helarc/composition");
  const {createDefaultHelarcInstructionSettings}=await import("@agent-anything/helarc/configuration");
  const defaults=createDefaultHelarcInstructionSettings();
  const settings=stopEvaluation?{...defaults,stop:defaults.stop.map(s=>({...s,enabled:true,content:"Check the supplied task evidence and permit ending when no further work is required."}))}:defaults;
  const workspace={primary:{id:"workspace",name:"Isolated native Product",rootRef:directory,trustState:"trusted",source:"test",policyRefs:[],metadata:{}},additional:[]};
  const commandActions=await commands.createHelarcLocalCommandActionCapability({processManagerId:"isolated-native-product",workspace,platform:"win32",
    commandOutputDirectory:join(directory,"command-output"),shellOperation:tools.HELARC_PROCESS_START_OPERATION,shellBinding:tools.HELARC_PROCESS_START_BINDING,
    initialObservationHandlerId:tools.HELARC_INITIAL_OBSERVATION_HANDLER,commandObserveHandlerId:tools.HELARC_COMMAND_OBSERVE_HANDLER,
    taskStopOperation:tools.HELARC_TASK_STOP_OPERATION,taskStopBinding:tools.HELARC_TASK_STOP_BINDING});
  return createHelarcNativeProductComposition({runId:"root",task:built.source.task,workspace,nativeModel:model,taskExecution,
    stopEvaluation:stopEvaluation??{kind:"purpose",id:"disabled-native-stop",evaluate:async()=>{throw new Error("Disabled Stop dispatched a request");}},
    nativeNarratives:h.createHelarcNativeNarrativeReader(store.protocolJournal),nativePresentation:(await import("@agent-anything/helarc/run")).createHelarcNativePresentationReader(store.protocolJournal),contextMaterials:materialAccess,reportHandoff,
    instructionTarget:"production",instructionSettings:settings,codeSource:files.createLocalCodeSourcePort(()=>new Date().toISOString()),
    fileActions:files.createHelarcLocalFileActionCapability({workspace}),commandActions,hookInvocationRecords:store});
};

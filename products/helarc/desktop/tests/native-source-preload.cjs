const {contextBridge,ipcRenderer}=require("electron");
contextBridge.exposeInMainWorld("helarc",Object.fromEntries(["readConversation","readConversationResponseGroup","readWorkbenchItem"]
  .map(method=>[method,query=>ipcRenderer.invoke("native-reading",method,query)])));

const {app}=require("electron"),{join}=require("node:path"),{pathToFileURL}=require("node:url");
const {writeFile}=require("node:fs/promises");
const directory=process.argv[2];
app.setPath("userData",join(directory,"evidence-electron"));app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
  const {HelarcExecutionStore}=await import(pathToFileURL(join(__dirname,"../../dist/main/execution-storage/HelarcExecutionStore.js")));
  const store=await HelarcExecutionStore.open(join(directory,"execution"));
  try{
    const tree=await store.readRunTree("root"),members=[];
    for(const member of tree.members){
      const runId=member.head.state.run.id,heads=new Map();let after=0,count=0;
      for(;;){
        const page=await store.protocolJournal.command({kind:"facts",runId,after,limit:128});
        for(const fact of page){
          if(fact.kind==="evidence"&&fact.value.kind==="transport")heads.set(fact.value.key,fact.value.metadata);
        }
        count+=page.length;if(page.length<128)break;after=page.at(-1).sequence;
        if(count>100000)throw new Error("Evidence page budget exceeded");
      }
      members.push({runId,status:member.head.state.status,task:member.admission.input.task.input,
        identitySequences:member.head.control.identitySequences,nativeHeads:[...heads],factCount:count});
    }
    await writeFile(join(directory,"native-diagnostics.json"),JSON.stringify({generation:store.generation,members},null,2));
    console.log(JSON.stringify(members.map(({runId,status,nativeHeads,factCount})=>({runId,status,nativeHeads,factCount}))));
  }finally{await store.close();}
}).then(()=>app.exit(0)).catch(e=>{console.error(e);app.exit(1);});

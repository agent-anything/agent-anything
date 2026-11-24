import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp,mkdir,readFile,rm,stat,writeFile} from "node:fs/promises";
import {DatabaseSync} from "node:sqlite";
import {tmpdir} from "node:os";
import {resolve,join,dirname,basename} from "node:path";
import {fileURLToPath} from "node:url";
import electron from "electron";

const root=await mkdtemp(join(tmpdir(),"helarc-protocol-journal-"));
const driver=fileURLToPath(new URL("./fixtures/protocol-journal.cjs",import.meta.url));
let passed=false;
async function launch(directory,scenario,phase,expected=0,timeout=60000){
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  let timedOut=false,killPromise=Promise.resolve(),output="";
  await new Promise((accept,reject)=>{
    const child=spawn(electron,[driver,directory,scenario,phase],{env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
    child.stdout.on("data",chunk=>{output=(output+chunk).slice(-12000);});child.stderr.on("data",chunk=>{output=(output+chunk).slice(-12000);});
    const timer=setTimeout(()=>{
      timedOut=true;
      killPromise=new Promise(done=>{
        if(process.platform==="win32"){
          const killer=spawn("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});killer.once("close",done);killer.once("error",()=>{child.kill();done();});
        }else{child.kill("SIGKILL");done();}
      });
    },timeout);
    child.once("error",error=>{clearTimeout(timer);reject(error);});
    child.once("close",async code=>{
      clearTimeout(timer);await killPromise;
      if((expected==="timeout"&&timedOut)||(code===expected&&!timedOut))accept();
      else reject(new Error(`${scenario}/${phase}: exit=${code} timeout=${timedOut}\n${await readFile(join(directory,"failure.txt"),"utf8").catch(()=>output)}`));
    });
  });
  console.log(`${scenario}/${phase}: passed`);
}
try{
  const scenarios=process.argv.slice(2).length?process.argv.slice(2):["input","dispatch","partial","response","acceptance","effect-dispatch","effect-applied","effect-confirmed","received","cancel-before-dispatch","material-receiver","material-source","material-mixed","integrity","timeout"];
  for(const scenario of scenarios){
    const directory=join(root,scenario);await mkdir(directory);
    if(scenario==="timeout-isolation"){
      const next=join(root,"following-independent");await mkdir(next);
      await launch(directory,scenario,"seed","timeout",5000);
      const armed=JSON.parse(await readFile(join(directory,"armed.json"),"utf8"));
      assert.throws(()=>process.kill(armed.pid,0),{code:"ESRCH"});
      await launch(next,"input","seed",73);
      await writeFile(join(directory,"release-late"),"following case has its own committed input");
      await launch(next,"input","resume");
      const db=new DatabaseSync(join(directory,"execution","execution.sqlite"),{readOnly:true});
      try{assert.deepEqual(db.prepare("SELECT id FROM protocol_contents").all().map(r=>r.id),["armed"]);}
      finally{db.close();}
      await assert.rejects(stat(join(directory,"late-effect")),{code:"ENOENT"});
      assert.equal(await readFile(join(next,"provider-creates"),"utf8"),"create\n");
      assert.equal(await readFile(join(next,"effects"),"utf8"),"write\n");
      const following=JSON.parse(await readFile(join(next,"verification.json"),"utf8"));
      await writeFile(join(directory,"verification.json"),JSON.stringify({armed,expiredOwnerExited:true,lateEffect:false,
        followingGeneration:following.generation,providerCreates:1,effects:1,acceptedPurposes:following.acceptedPurposes}));
    }else if(scenario==="integrity")await launch(directory,scenario,"verify");
    else if(scenario==="timeout"){
      await launch(directory,"timeout","seed","timeout",5000);
      await stat(join(directory,"started"));
      await launch(directory,"input","seed",73);
      await launch(directory,"input","resume");
    }else{await launch(directory,scenario,"seed",73);await launch(directory,scenario,"resume");}
    const result=JSON.parse(await readFile(join(directory,"verification.json"),"utf8"));
    console.log(JSON.stringify({...result,timing:result.timing?.length}));
  }
  passed=true;console.log(`Real Electron and SQLite Worker validation passed (${scenarios.length} scenarios).`);
}finally{
  if(passed&&process.env.HELARC_KEEP_VERIFICATION_EVIDENCE!=="1"){const target=resolve(root);assert.equal(dirname(target),resolve(tmpdir()));assert(basename(target).startsWith("helarc-protocol-journal-"));await rm(target,{recursive:true,force:true});}
  else if(passed)console.log(`Verification evidence retained: ${root}`);
  else console.error(`Failure evidence retained: ${root}`);
}

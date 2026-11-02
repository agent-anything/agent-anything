import {mkdtemp,mkdir,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {comparisonDefinition,contextTrialPlan} from "./comparison-cases.mjs";
import {runContextProcessTrial} from "./context-process-runner.mjs";
import {processPlan,runDesktopProcessTrial} from "./process-runner.mjs";
import {writeImmutable,digest} from "./process-storage.mjs";
import {comparisonTrial,publishComparison} from "./comparison-report.mjs";
const argument=name=>{const index=process.argv.indexOf(name);return index<0?null:process.argv[index+1];};
const directory=argument("--directory")?resolve(argument("--directory")):await mkdtemp(join(tmpdir(),"helarc-comparisons-"));
await mkdir(directory,{recursive:true});console.log(directory);
const cancel=new AbortController();process.once("SIGINT",()=>cancel.abort());
const kinds=argument("--case")?[argument("--case")]:process.argv.includes("--heldout")?["C01","C02","C03"]:["C01","C02","C03","C04"];
if(process.argv.includes("--heldout")&&kinds.includes("C04"))throw new Error("Held-out source variant is defined for C01-C03 only");
for(const kind of kinds){
  const values=[];
  const live=process.argv.includes("--live"),definition=comparisonDefinition(kind,{live,repetitions:Number(argument("--repetitions")??1)});
  if(argument("--arm")&&!definition.arms.includes(argument("--arm")))throw new Error("Unknown comparison arm");
  const file=join(directory,`${kind}-definition.json`),original=await readFile(file,"utf8").then(JSON.parse).catch(e=>{if(e.code==="ENOENT")return null;throw e;});
  if(original&&digest(original)!==digest(definition))throw new Error("Original comparison definition changed");
  if(!original)await writeImmutable(file,definition);
  for(const entry of definition.order.filter(entry=>!argument("--arm")||entry.arm===argument("--arm"))){
    const trialDirectory=join(directory,`${kind}-${entry.arm}-${entry.repetition}`);await mkdir(trialDirectory,{recursive:true});
    const planFile=join(trialDirectory,"plan.json");
    let plan=await readFile(planFile,"utf8").then(JSON.parse).catch(e=>{if(e.code==="ENOENT")return null;throw e;});
    if(!plan){
      const base=contextTrialPlan(definition,entry,{live,heldout:process.argv.includes("--heldout")});plan={...base,targetInput:{...base.targetInput,inspectionRoot:join(directory,"inspection")}};
      if(kind==="C04"){
        const root=processPlan(base.trial.ref.id);plan={...root,trial:{...base.trial,targetSnapshotRef:root.trial.targetSnapshotRef},
          startingState:{...root.startingState,construction:{id:"isolated-context-task",revision:"1"},entries:root.startingState.entries.map(e=>e.facet==="sources"?{...e,disposition:"reconstructible",evidence:[{id:"declared-workspace-sources",revision:"1"}]}:e)},
          targetInput:{comparison:kind,arm:entry.arm,model:base.targetInput.model,live,sourceFiles:base.targetInput.sources,inspectionRoot:join(directory,"inspection"),
            prompt:`POLICY_TASK_ROOT: Read evidence-a.txt and evidence-b.txt. Delegate one child to independently inspect the same evidence and report its findings. Do not modify files. ${base.targetInput.prompt}`},
          expectationRefs:base.expectationRefs,claimRefs:base.claimRefs,futureStimuli:[],evidenceLimitations:definition.limitations};
      }
      await writeImmutable(planFile,plan);
    }
    const outcome=await (kind==="C04"?runDesktopProcessTrial:runContextProcessTrial)({directory:trialDirectory,plan,live,signal:cancel.signal,timeoutMs:definition.stopping.trialTimeoutMs});
    console.log(JSON.stringify({kind,...entry,directory:trialDirectory,execution:outcome.report.execution,failures:outcome.report.failures,conclusions:outcome.report.conclusions,cleanup:outcome.report.cleanup.status}));
    const manualGrades=argument("--manual-grades")?JSON.parse(await readFile(argument("--manual-grades"),"utf8")):[];
    values.push(await comparisonTrial({directory:trialDirectory,plan,entry,outcome,modelGrading:process.argv.includes("--model-grading"),manualGrades}));
    if(outcome.report.cleanup.status!=="cleaned"||cancel.signal.aborted)break;
  }
  console.log(JSON.stringify({published:await publishComparison(directory,definition,values)}));
  if(cancel.signal.aborted||values.some(v=>v.trial.report.cleanup.status!=="cleaned"))break;
}

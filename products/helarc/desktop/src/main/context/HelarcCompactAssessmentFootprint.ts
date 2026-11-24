/** Only a confirmed absence at every admission boundary establishes that the local stage did not send. */
export async function confirmUnstartedCompactAssessment(pathId:string,signal:AbortSignal,read:{
  native:(id:string)=>Promise<unknown>;preparation:(id:string)=>Promise<unknown>;connection:(id:string)=>Promise<unknown>;
},includesOwnershipRepair=false):Promise<string[]>{
  const ids=["oracle",...(includesOwnershipRepair?["plan-ownership"]:[]),"probe","judgment"].flatMap(step=>{
    const id=pathId+":compact-assessment:"+step;return [id,id+":input-count"];
  });
  for(const id of ids){
    signal.throwIfAborted();
    if(await read.native(id)!==null||await read.preparation(id+":prepare")!==null||await read.connection(id+":connection")!==null)
      throw new TypeError("compact_assessment_original_activity_requires_reconciliation");
  }
  return ids;
}

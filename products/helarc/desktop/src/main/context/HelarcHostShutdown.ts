export interface HelarcHostShutdownResult {
  readonly incomplete:readonly string[];
  readonly failed:readonly {readonly stage:string;readonly error:unknown}[];
}

/** One Host deadline; expiry reports an unknown boundary, not successful settlement. */
export async function closeHelarcHost(input:{
  readonly timeoutMs?:number;
  readonly activities?:(remainingMs:number)=>Promise<unknown>;
  readonly inspection?:()=>Promise<unknown>;
  readonly storage?:()=>Promise<unknown>;
  readonly diagnostics?:()=>Promise<unknown>;
}):Promise<HelarcHostShutdownResult> {
  const timeoutMs=input.timeoutMs??10000;
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<0)throw new TypeError("host_shutdown_budget_invalid");
  const deadline=performance.now()+timeoutMs,incomplete:string[]=[],failed:{stage:string;error:unknown}[]=[];
  const remaining=()=>Math.max(0,deadline-performance.now());
  const step=async(name:string,action:(remainingMs:number)=>Promise<unknown>,limit=remaining())=>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      const outcome=await Promise.race([
        Promise.resolve().then(()=>action(remaining())).then(()=>"confirmed" as const),
        new Promise<"unknown"> (resolve=>{timer=setTimeout(()=>resolve("unknown"),Math.max(0,Math.min(limit,remaining())));}),
      ]);
      if(outcome==="unknown")incomplete.push(name);
    } catch(error){failed.push({stage:name,error});}
    finally{if(timer!==undefined)clearTimeout(timer);}
  };
  if(input.activities)await step("activities",input.activities);
  if(input.inspection)await step("inspection",input.inspection,1000);
  if(input.storage)await step("storage",input.storage);
  if(input.diagnostics)await step("diagnostics",input.diagnostics);
  return {incomplete,failed};
}

import {setTimeout as delay} from "node:timers/promises";
import {beginExecutionTiming} from "../diagnostics/ExecutionPerformance.js";
import {reportExecutionFailure,type ExecutionDiagnosticSink} from "../diagnostics/HelarcExecutionDiagnostics.js";

export interface NativeFollowUpPage {
  readonly more:boolean;
  readonly examined:number;
}

/** Each owner advances its own bounded page; unavailable siblings do not block discovery. */
export async function driveNativeFollowUpPages(input:{
  readonly owner:string;
  readonly signal:AbortSignal;
  readonly page:()=>Promise<NativeFollowUpPage>;
  readonly diagnostics?:ExecutionDiagnosticSink;
}):Promise<void>{
  let previousFailure:string|null=null;
  while(!input.signal.aborted){
    const end=beginExecutionTiming(input.diagnostics,"native_follow_up.page",{responsibility:input.owner});
    let more=false;
    try{
      const result=await input.page();
      if(!Number.isSafeInteger(result.examined)||result.examined<0||result.examined>16)
        throw new TypeError("native_follow_up_page_bound_invalid");
      more=result.more;previousFailure=null;
      end("ok",{examined:result.examined,more:more?1:0});
    }catch(error){
      end(input.signal.aborted?"unknown":"failed");
      if(input.signal.aborted)return;
      const message=error instanceof Error?error.message:String(error);
      if(message!==previousFailure)reportExecutionFailure(input.diagnostics,"native_follow_up_page_blocked",{responsibility:input.owner},error);
      previousFailure=message;
    }
    // Even full pages yield; an empty owner does not spin on its own durable index.
    try{await delay(more?0:1000,undefined,{signal:input.signal});}
    catch(error){if(!input.signal.aborted)throw error;}
  }
}

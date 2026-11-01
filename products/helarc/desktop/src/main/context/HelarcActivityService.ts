import {
  ActivityHandoffProcessor, ActivityHandoffPump, ActivityReconsiderationProcessor, ActivityHostUnavailableError,
  type ActivityPurposeHandler, type ActivityPurposeResolver, type ActivityPendingScope,
  type ActivityHandoffCycle,
} from "@agent-anything/agent-runtime/activity";
import type {HelarcExecutionStore} from "../execution-storage/HelarcExecutionStore.js";
import {reportExecutionFailure, type ExecutionDiagnosticSink} from "../diagnostics/HelarcExecutionDiagnostics.js";

export interface HelarcActivityServiceOptions {
  readonly store:HelarcExecutionStore;
  readonly purposes:ActivityPurposeResolver<ActivityPurposeHandler>;
  readonly purposeIds:readonly string[];
  readonly diagnostics?:ExecutionDiagnosticSink;
  readonly rediscoveryMs?:number;
  readonly scopeAvailable?:(runId:string)=>Promise<boolean>;
  readonly report?:(cycle:ActivityHandoffCycle)=>Promise<void>;
  readonly reconsideration?:ConstructorParameters<typeof ActivityReconsiderationProcessor>[2];
}

/** Host-owned execution lifetime; opening a window or making a task call does not drive it. */
export class HelarcActivityService {
  private readonly controller=new AbortController();
  private readonly processor:ActivityHandoffProcessor;
  private readonly pump:ActivityHandoffPump;
  private readonly unsubscribe:()=>void;
  private readonly completion:Promise<void>;
  private cursor:string|null=null;
  private failure:unknown=null;
  private closed=false;
  private closing:Promise<{readonly localExecutionsFinished:boolean;readonly localInFlight:number}>|null=null;
  private readonly issues=new Map<string,string>();

  constructor(private readonly options:HelarcActivityServiceOptions) {
    this.processor=new ActivityHandoffProcessor(options.store.activityHandoffs,options.purposes,
      options.store.activityJournal.executor,()=>new Date().toISOString(),options.purposeIds);
    this.pump=new ActivityHandoffPump(options.store.activityHandoffs,this.processor,options.reconsideration?
      new ActivityReconsiderationProcessor(options.store.activityHandoffs,options.store.sharedAcceptance,options.reconsideration):undefined);
    this.unsubscribe=options.store.onActivityChange(()=>this.pump.wake());
    this.completion=this.pump.run({signal:this.controller.signal,rediscoveryMs:options.rediscoveryMs,
      scopes:async()=>{
        const read=()=>options.store.activityHandoffs.command({kind:"pending_scopes",afterRunId:this.cursor,limit:64});
        let scopes=await read() as readonly ActivityPendingScope[];
        if(!scopes.length&&this.cursor){this.cursor=null;scopes=await read() as readonly ActivityPendingScope[];}
        this.cursor=scopes.at(-1)?.runId??null;
        const ready:ActivityPendingScope[]=[];
        for(const scope of scopes) {
          try {
            if(!options.scopeAvailable||await options.scopeAvailable(scope.runId))ready.push(scope);
            this.issues.delete(`binding:${scope.runId}`);
          } catch(error) {
            const key=`binding:${scope.runId}`,message=error instanceof Error?error.message:String(error);
            if(this.issues.get(key)!==message)reportExecutionFailure(options.diagnostics,"activity_binding",{runId:scope.runId},error);
            this.issues.set(key,message);
            if(this.issues.size>256)this.issues.delete(this.issues.keys().next().value!);
          }
        }
        return ready.map(scope=>({...scope,signal:this.controller.signal}));
      },report:async cycle=>{
        for(const run of cycle.runs) {
          const key=run.result.failures.map(f=>`${f.requestId}:${f.error instanceof Error?f.error.message:String(f.error)}`).join("\n");
          if(key&&this.issues.get(run.runId)!==key)for(const issue of run.result.failures)
            reportExecutionFailure(options.diagnostics,"activity_handoff",{runId:run.runId,requestId:issue.requestId},issue.error);
          if(key)this.issues.set(run.runId,key);else this.issues.delete(run.runId);
          if(this.issues.size>256)this.issues.delete(this.issues.keys().next().value!);
        }
        for(const issue of cycle.failures)reportExecutionFailure(options.diagnostics,"activity_scope",{runId:issue.runId},issue.error);
        for(const run of cycle.reconsiderations) {
          const key=`reconsideration:${run.runId}`;
          const signature=run.result.failures.map(f=>`${f.subscriptionId}:${f.error instanceof Error?f.error.message:String(f.error)}`).join("\n");
          if(signature&&this.issues.get(key)!==signature)for(const issue of run.result.failures)
            reportExecutionFailure(options.diagnostics,"activity_reconsideration",{runId:run.runId,subscriptionId:issue.subscriptionId},issue.error);
          if(signature)this.issues.set(key,signature);else this.issues.delete(key);
          if(this.issues.size>256)this.issues.delete(this.issues.keys().next().value!);
        }
        await options.report?.(cycle);
      }}).catch(error=>{
        if(!this.controller.signal.aborted){this.failure=error;this.processor.stopDispatch();
          reportExecutionFailure(options.diagnostics,"activity_service",{},error);}
      });
  }

  assertAvailable(phase:"progression"|"settlement"="progression"):void {
    if(this.failure!==null)throw new ActivityHostUnavailableError("failed",{cause:this.failure});
    if(this.closed)throw new ActivityHostUnavailableError("closed");
    if(this.closing&&phase!=="settlement")throw new ActivityHostUnavailableError("closing");
  }
  wake():void {this.assertAvailable();this.pump.wake();}
  close(timeoutMs=10000):Promise<{readonly localExecutionsFinished:boolean;readonly localInFlight:number}> {
    if(!Number.isFinite(timeoutMs)||timeoutMs<0)throw new TypeError("activity_shutdown_budget_invalid");
    return this.closing??=this.closeWithin(timeoutMs);
  }
  private async closeWithin(timeoutMs:number):Promise<{readonly localExecutionsFinished:boolean;readonly localInFlight:number}> {
    const deadline=performance.now()+timeoutMs;
    this.processor.stopDispatch();this.pump.wake();
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      await Promise.race([this.processor.settled(),new Promise<void>(resolve=>{timer=setTimeout(resolve,timeoutMs);})]);
    } finally {
      if(timer!==undefined)clearTimeout(timer);
      this.closed=true;
      this.unsubscribe();this.controller.abort(new Error("activity_host_closed"));
    }
    // A timed-out physical attempt remains durably unresolved, never falsely released.
    await boundedWait(this.completion,Math.max(0,deadline-performance.now()));
    return {localExecutionsFinished:this.processor.inFlight===0,localInFlight:this.processor.inFlight};
  }
}

async function boundedWait(work:Promise<void>,milliseconds:number):Promise<void> {
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {await Promise.race([work,new Promise<void>(resolve=>{timer=setTimeout(resolve,milliseconds);})]);}
  finally {if(timer!==undefined)clearTimeout(timer);}
}

import type {ActivityHandoffPort} from "./ActivityHandoff.js";
import type {ActivityHandoffProcessor,ActivityDrainResult} from "./ActivityHandoffProcessor.js";
import type {ActivitySchedulingReview} from "./ActivityScheduling.js";
import type {ActivityReconsiderationProcessor,ActivityReconsiderationCycle} from "./ActivityReconsiderationProcessor.js";

export interface ActivityExecutionScope {
  readonly runId:string;
  readonly signal:AbortSignal;
}
export interface ActivityHandoffCycle {
  readonly runs:readonly {readonly runId:string;readonly result:ActivityDrainResult}[];
  readonly failures:readonly {readonly runId:string;readonly error:unknown}[];
  readonly review:ActivitySchedulingReview;
  readonly reconsiderations:readonly {readonly runId:string;readonly result:ActivityReconsiderationCycle}[];
}

/** Only discovers and advances entrusted handoffs; it does not choose professional work. */
export class ActivityHandoffPump {
  private revision=0;
  private wakeWaiter:(()=>void)|null=null;
  private running=false;
  constructor(private readonly port:ActivityHandoffPort,private readonly processor:ActivityHandoffProcessor,
    private readonly reconsideration?:ActivityReconsiderationProcessor) {}
  wake():void {this.revision++;this.wakeWaiter?.();}
  async cycle(scopes:readonly ActivityExecutionScope[]):Promise<ActivityHandoffCycle> {
    if(scopes.length>256||new Set(scopes.map(s=>s.runId)).size!==scopes.length)throw new TypeError("activity_pump_scopes_invalid");
    const runs:{runId:string;result:ActivityDrainResult}[]=[],failures:{runId:string;error:unknown}[]=[];
    const reconsiderations:{runId:string;result:ActivityReconsiderationCycle}[]=[];
    const review=await this.port.command({kind:"review_scheduling"}) as ActivitySchedulingReview;
    for(const scope of scopes) {
      if(scope.signal.aborted)continue;
      try {
        if(this.reconsideration)reconsiderations.push({runId:scope.runId,result:await this.reconsideration.scan(scope.runId,scope.signal)});
        runs.push({runId:scope.runId,result:await this.processor.scan(scope.runId,scope.signal)});
      }
      catch(error){failures.push({runId:scope.runId,error});}
    }
    return {runs,failures,review,reconsiderations};
  }
  async run(input:{
    readonly signal:AbortSignal;
    readonly scopes:()=>readonly ActivityExecutionScope[];
    readonly report:(cycle:ActivityHandoffCycle)=>Promise<void>;
    readonly rediscoveryMs?:number;
  }):Promise<void> {
    if(this.running)throw new TypeError("activity_pump_already_running");
    const interval=input.rediscoveryMs??1000;
    if(!Number.isSafeInteger(interval)||interval<1||interval>60000)throw new TypeError("activity_pump_interval_invalid");
    this.running=true;
    try {
      while(!input.signal.aborted) {
        const revision=this.revision;
        const cycle=await this.cycle(input.scopes());
        await input.report(cycle);
        if(input.signal.aborted)break;
        // Publication wakes discovery; an occasional durable scan covers lost process notifications.
        if(cycle.runs.some(run=>run.result.progressed.length)||cycle.reconsiderations.some(r=>r.result.accepted.length))continue;
        const reviewDelay=cycle.review.nextReviewAt===null?interval:Math.max(1,Date.parse(cycle.review.nextReviewAt)-Date.now());
        await this.wait(input.signal,Math.min(interval,reviewDelay),revision);
      }
    } finally {this.running=false;this.wakeWaiter=null;}
  }
  private wait(signal:AbortSignal,ms:number,revision:number):Promise<void> {
    if(signal.aborted||revision!==this.revision)return Promise.resolve();
    return new Promise(resolve=>{
      const finish=()=>{clearTimeout(timer);signal.removeEventListener("abort",finish);if(this.wakeWaiter===finish)this.wakeWaiter=null;resolve();};
      const timer=setTimeout(finish,ms);
      this.wakeWaiter=finish;signal.addEventListener("abort",finish,{once:true});
      if(signal.aborted||revision!==this.revision)finish();
    });
  }
}

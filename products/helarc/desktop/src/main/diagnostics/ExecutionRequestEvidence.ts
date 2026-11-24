import type {ExecutionPerformanceEvent} from "./ExecutionPerformance.js";

interface RequestEvidence {
  readonly key:string;
  readonly events:ExecutionPerformanceEvent[];
  droppedEvents:number;
  started:boolean;
  finished:boolean;
  durationMs:number;
  failed:boolean;
}

/** Retain causal groups, including late Worker samples after the Host receives its ACK. */
export class ExecutionRequestEvidence {
  private readonly groups=new Map<string,RequestEvidence>();
  private evictedRequests=0;
  constructor(private readonly limits={recent:32,slow:16,active:32,events:128}) {}

  record(event:ExecutionPerformanceEvent):void {
    const {storageInstanceId,generation,requestId}=event.context;
    if(typeof storageInstanceId!=="string"||typeof generation!=="number"||typeof requestId!=="number")return;
    const key=`${storageInstanceId}:${generation}:${requestId}`;
    let group=this.groups.get(key);
    if(!group){group={key,events:[],droppedEvents:0,started:false,finished:false,durationMs:0,failed:false};this.groups.set(key,group);}
    if(event.stage==="storage.host.request") {
      if(event.kind==="started")group.started=true;
      else {group.finished=true;group.durationMs=event.durationMs;group.failed=event.outcome!=="ok";}
    }
    if(group.events.length<this.limits.events)group.events.push(event);
    else group.droppedEvents++;
    this.trim();
  }

  snapshot() {
    return {evictedRequests:this.evictedRequests,limits:{...this.limits},requests:[...this.groups.values()].map(group=>{
      const unfinished=new Set<string>();
      for(const event of group.events) {
        if(event.kind==="started")unfinished.add(event.id);
        else unfinished.delete(event.id);
      }
      return {...group,events:[...group.events],unfinishedSpans:unfinished.size,
        complete:group.started&&group.finished&&group.droppedEvents===0&&unfinished.size===0};
    })};
  }

  private trim():void {
    if(this.groups.size<=this.limits.recent+this.limits.slow+this.limits.active)return;
    const values=[...this.groups.values()],completed=values.filter(group=>group.finished);
    const retained=new Set([...values.filter(group=>!group.finished).slice(-this.limits.active),
      ...completed.slice(-this.limits.recent),
      ...completed.sort((a,b)=>Number(b.failed)-Number(a.failed)||b.durationMs-a.durationMs).slice(0,this.limits.slow)]);
    for(const [key,group] of this.groups)if(!retained.has(group)){this.groups.delete(key);this.evictedRequests++;}
  }
}

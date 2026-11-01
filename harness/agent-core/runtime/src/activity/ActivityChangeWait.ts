/** Wake hints never replace the caller's durable state read. */
export class ActivityChangeWait {
  version=0;
  private release:(()=>void)|null=null;
  private readonly unsubscribe:()=>void;
  private readonly changed=()=>{this.version++;this.release?.();};
  constructor(host:{subscribe(listener:()=>void):()=>void},private readonly signal:AbortSignal|null) {
    this.unsubscribe=host.subscribe(this.changed);
    signal?.addEventListener("abort",this.changed);
  }
  async wait(version:number,milliseconds:number):Promise<void> {
    if(!Number.isFinite(milliseconds)||milliseconds<0)throw new TypeError("activity_wait_bound_invalid");
    if(version!==this.version||this.signal?.aborted)return;
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {await new Promise<void>(resolve=>{this.release=resolve;timer=setTimeout(resolve,milliseconds);});}
    finally {if(timer!==undefined)clearTimeout(timer);this.release=null;}
  }
  close():void {this.unsubscribe();this.signal?.removeEventListener("abort",this.changed);this.release?.();}
}

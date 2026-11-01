import type {
  ActivityPurposeBinding,ActivityPurposeHandler,ActivityPurposeResolver,
  ActivityReconsiderationHandler,ActivityReconsiderationSubscription,
} from "@agent-anything/agent-runtime/activity";

/** Process-local implementations of already validated original bindings, never authorization state. */
export class HelarcActivityBindings implements ActivityPurposeResolver<ActivityPurposeHandler> {
  constructor(private readonly originalRoot?: (runId:string)=>Promise<string|null>) {}
  private readonly scopes=new Map<string,{
    readonly originalBindingId:string;
    readonly purposes:ActivityPurposeResolver<ActivityPurposeHandler>;
    readonly reconsideration?:(owner:string,subscription:ActivityReconsiderationSubscription)=>ActivityReconsiderationHandler|null;
  }>();

  bind(runId:string,binding:{
    readonly originalBindingId:string;
    readonly purposes:ActivityPurposeResolver<ActivityPurposeHandler>;
    readonly reconsideration?:(owner:string,subscription:ActivityReconsiderationSubscription)=>ActivityReconsiderationHandler|null;
  }):void {
    if(!runId.trim()||!binding.originalBindingId.trim())throw new TypeError("activity_host_binding_invalid");
    const original=this.scopes.get(runId);
    if(original&&original!==binding)throw new TypeError("activity_host_binding_already_resolved");
    this.scopes.set(runId,binding);
  }
  private async scope(runId:string) {
    const direct=this.scopes.get(runId);
    if(direct)return direct;
    const root=await this.originalRoot?.(runId);
    return root?this.scopes.get(root):undefined;
  }
  async available(runId:string):Promise<boolean> {return Boolean(await this.scope(runId));}
  async resolve(binding:ActivityPurposeBinding,scope:{runId:string;pathId:string}) {
    const original=await this.scope(scope.runId);
    if(!original)throw new TypeError("activity_original_scope_binding_unavailable");
    return original.purposes.resolve(binding,scope);
  }
  reconsideration(owner:string,subscription:ActivityReconsiderationSubscription):ActivityReconsiderationHandler|null {
    const direct=this.scopes.get(subscription.runId);
    if(direct)return direct.reconsideration?.(owner,subscription)??null;
    if(!this.originalRoot)return null;
    return {prepare:async(snapshot,signal)=>{
      const original=await this.scope(subscription.runId);
      const handler=original?.reconsideration?.(owner,subscription);
      if(!handler)throw new TypeError("activity_original_reconsideration_unavailable");
      signal.throwIfAborted();return handler.prepare(snapshot,signal);
    }};
  }
}

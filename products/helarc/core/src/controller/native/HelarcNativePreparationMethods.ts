import type {ActivityHandoffPort,ActivityPathState} from "@agent-anything/agent-runtime/activity";
import type {ContextPreparationMethodRequest,RepresentationMethodWork} from "@agent-anything/agent-runtime/context-representation";
import {RESPONSES_COMPACT_METHOD} from "@agent-anything/provider-integrations/native";
import type {HelarcResponsesCompactWork} from "./HelarcResponsesCompactWork.js";

/** Original-owner routing only. Offering, investment and native execution remain separate. */
export class HelarcNativePreparationMethods {
  constructor(private readonly ports:{readonly activities:ActivityHandoffPort;readonly local:RepresentationMethodWork;
    readonly compact:HelarcResponsesCompactWork|null}){}

  prepareSubmission(intent:Parameters<RepresentationMethodWork["prepareSubmission"]>[0],request:ContextPreparationMethodRequest){
    if(request.method!=="protocol")return this.ports.local.prepareSubmission(intent,request);
    if(request.execution.owner!==RESPONSES_COMPACT_METHOD.id||request.execution.protocol.id!=="openai.responses"||!this.ports.compact)
      throw new TypeError("native_preparation_method_owner_unavailable");
    return this.ports.compact.prepareSubmission(intent,request);
  }
  async describe(pathId:string){return (await this.owner(pathId)).describe(pathId);}
  async prepareClosure(pathId:string,basis:string){return (await this.owner(pathId)).prepareClosure(pathId,basis);}
  private async owner(pathId:string){
    const path=await this.ports.activities.command({kind:"read_path",pathId}) as ActivityPathState|null;
    if(!path)throw new TypeError("native_preparation_original_path_unavailable");
    const owner=[this.ports.local,this.ports.compact].find(value=>value&&value.purpose.digest===path.intent.purpose.digest);
    if(!owner)throw new TypeError("native_preparation_original_owner_unavailable");
    return owner;
  }
}

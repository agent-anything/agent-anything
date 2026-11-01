import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {TASK_MODEL_RESPONSE_PURPOSE,type TaskModelSource} from "../decision/TaskModelResponsePath.js";
import {validateTaskDecisionSource} from "../decision/TaskDecisionSourceRecord.js";
import {OriginalInputSupply,type OriginalInputSupplyBasis} from "./OriginalInputSupply.js";

export type {OriginalInputSourcePublication as TaskInputSourcePublication,OriginalInputSupplyBinding as TaskInputSupplyBinding,
  OriginalInputSupplyDecision as TaskInputSupplyDecision} from "./OriginalInputSupply.js";
export type TaskInputSupplyBasis = OriginalInputSupplyBasis<TaskModelSource>;

/** Task source rules specialize shared input handoffs without lending task authority to other purposes. */
export class TaskInputSupply extends OriginalInputSupply<TaskModelSource> {
  constructor(ports:Omit<ConstructorParameters<typeof OriginalInputSupply<TaskModelSource>>[0],"source">) {
    super({...ports,source:{
      stageId:(_need,consumer)=>`${consumer.intent.id}:source`,
      validate:(value,consumer):asserts value is TaskModelSource=>{
        const source=value as TaskModelSource;
        if(consumer.intent.purpose.digest!==modelInputValueDigest(TASK_MODEL_RESPONSE_PURPOSE)||
          source?.kind!=="task_model_source"||source.record?.source.runId!==consumer.intent.runId)
          throw new TypeError("task_input_original_source_missing");
        validateTaskDecisionSource(source.record);
      },
    }});
  }
}

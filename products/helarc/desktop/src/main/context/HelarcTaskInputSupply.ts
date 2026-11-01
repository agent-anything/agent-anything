import {createHelarcTaskInputSources} from "@agent-anything/helarc/prompt";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {TASK_MODEL_RESPONSE_PURPOSE,validateTaskDecisionSource,type TaskModelSource} from "@agent-anything/agent-runtime/decision";
import {acceptedConversationRepresentationContinuity} from "@agent-anything/agent-runtime/context-representation";
import {createHelarcOriginalInputSupply,type HelarcOriginalInputSupplyPorts} from "./HelarcOriginalInputSupply.js";

export type {HelarcOriginalInputBinding as HelarcTaskInputBinding} from "./HelarcOriginalInputSupply.js";
export {supplyHelarcOriginalInputRepresentationMethods as supplyHelarcTaskRepresentationMethods,
  resupplyHelarcOriginalInputRepresentationMethod as resupplyHelarcTaskRepresentationMethod,
  supplyHelarcOriginalInputMethodInput as supplyHelarcTaskMethodInput} from "./HelarcOriginalInputSupply.js";
export type HelarcTaskInputSupplyPorts=Omit<HelarcOriginalInputSupplyPorts<TaskModelSource>,"source"|"describe">;

export function helarcTaskInputSourceRules():Pick<HelarcOriginalInputSupplyPorts<TaskModelSource>,"source"|"describe"> {
  return {source:{
    stageId:(_need,consumer)=>`${consumer.intent.id}:source`,
    validate:(value,consumer):asserts value is TaskModelSource=>{
      const source=value as TaskModelSource;
      if(consumer.intent.purpose.digest!==modelInputValueDigest(TASK_MODEL_RESPONSE_PURPOSE)||
        source?.kind!=="task_model_source"||source.record?.source.runId!==consumer.intent.runId)
        throw new TypeError("helarc_task_original_source_changed");
      validateTaskDecisionSource(source.record);
    },
  },describe:basis=>({
    sources:createHelarcTaskInputSources(basis.source.record,basis.source.request),
    recipient:{runId:basis.consumer.intent.runId,recipient:basis.source.record.source.agent.id,purpose:basis.source.request.purpose},
    observation:{sequence:basis.source.record.source.iteration,representationContinuity:acceptedConversationRepresentationContinuity(basis.source.record.source.interaction)},
  })};
}
export function createHelarcTaskInputSupply(ports:HelarcTaskInputSupplyPorts) {
  return createHelarcOriginalInputSupply({...ports,...helarcTaskInputSourceRules()});
}

import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {createHelarcStopInputSources} from "@agent-anything/helarc/prompt";
import {HELARC_STOP_MODEL_PURPOSE,validateHelarcStopModelSource,type HelarcStopModelSource} from "@agent-anything/helarc/task-fulfillment";
import {createHelarcInputPreparation} from "./HelarcInputPreparation.js";

export function createHelarcStopPreparation(
  ports:Omit<Parameters<typeof createHelarcInputPreparation<HelarcStopModelSource>>[0],"source"|"describe">,
) {
  return createHelarcInputPreparation({...ports,source:{stageId:(_need,consumer)=>`${consumer.intent.id}:source`,
    validate:(value,consumer):asserts value is HelarcStopModelSource=>{
      const source=value as HelarcStopModelSource;validateHelarcStopModelSource(source);
      if(consumer.intent.purpose.digest!==modelInputValueDigest(HELARC_STOP_MODEL_PURPOSE)||consumer.intent.runId!==source.event.run.id)
        throw new TypeError("helarc_stop_original_source_changed");
    }},describe:basis=>({sources:createHelarcStopInputSources(basis.source),
      recipient:{runId:basis.consumer.intent.runId,recipient:HELARC_STOP_MODEL_PURPOSE.acceptanceOwner,purpose:basis.source.request.purpose},
      observation:{sequence:basis.source.event.iteration,representationContinuity:modelInputValueDigest({
        purpose:HELARC_STOP_MODEL_PURPOSE.ref,agent:basis.source.event.agent,instructions:basis.source.request.metadata.stopInstructionsRevision})}})});
}

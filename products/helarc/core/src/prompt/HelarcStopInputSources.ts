import {snapshotProviderRequest} from "@agent-anything/model-interaction";
import {modelInputValueDigest,type InputDuty} from "@agent-anything/model-interaction/input";
import {validateOriginalInputSources,type OriginalInputSources} from "@agent-anything/agent-runtime/context-representation";
import {validateHelarcStopModelSource,type HelarcStopModelSource} from "../task-fulfillment/HelarcTaskFulfillmentHook.js";

/** Stop evidence is Product-owned data, not a new task exchange or a task result delivery. */
export function createHelarcStopInputSources(original:HelarcStopModelSource):OriginalInputSources {
  validateHelarcStopModelSource(original);
  const request=snapshotProviderRequest(original.request),owner="helarc-stop-input";
  const basis={owner,runId:original.event.run.id,originalSourceId:original.id,boundary:original.revision,request,
    groups:request.composition.sections.map((section,position)=>({id:`${original.id}:${position}`,revision:modelInputValueDigest(section),owner,
      occurrences:[{section,position}],duties:(section.role==="instruction"?["behavior"]:section.kind==="stop_interaction_evidence"?
        ["evidence","continuity"]:["objective","new_information"]) as InputDuty[],
      sources:[section.source,...section.provenance?.sources??[]],deliveries:[],
      ...(section.kind==="stop_interaction_evidence"?{dataTexts:[{id:`${section.id}:body`,sectionId:section.id,
        owner:{owner,kind:"data_text_declaration",id:`${section.id}:body`,revision:modelInputValueDigest(section)},contentDigest:modelInputValueDigest(section.content),
        requirements:section.preservation!.obligations.map(obligation=>({id:obligation.id,revision:modelInputValueDigest(section),
          basis:"Product Stop evidence contract",description:obligation.basis}))}]}:{})}))};
  const sources={id:`stop-input-sources:${modelInputValueDigest(basis)}`,...basis};
  validateOriginalInputSources(sources);return sources;
}

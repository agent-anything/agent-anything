import {contextProcessObject,contextProcessRelationship,type ContextProcessRelationship} from "@agent-anything/context/evidence";
import type {ActivityHandoffFact} from "../activity/ActivityHandoff.js";
import type {ActivityPublishedFact,ActivityReconsiderationReceipt} from "../activity/ActivityReconsideration.js";

/** Public descriptions of this owner's published vocabulary, not generic coordinator interpretation. */
export function contextActivityFactObservation(fact:ActivityHandoffFact) {
  const links:ContextProcessRelationship[]=[];
  let referenceRevision:string|null|undefined;
  let closure:{subject:ReturnType<typeof contextProcessObject>;kind:string;status:string}|null=null;
  if(fact.kind==="fact_published") {
    const publication=fact.details.fact as ActivityPublishedFact,ref=publication.ref;
    if(ref.owner==="context_delivery")referenceRevision=null;
    if(ref.owner==="context-representation"&&["method_input_checked","method_input_unavailable","method_input_closed"].includes(ref.kind)) {
      links.push(contextProcessRelationship("produces",contextProcessObject("activity",ref.id,fact.runId),contextProcessObject(ref.owner,ref.id,fact.runId,ref.revision)));
    }
  }
  if(fact.kind==="reconsideration_accepted") {
    const receipt=fact.details.receipt as ActivityReconsiderationReceipt,ref=receipt.decision;
    if(ref.owner==="context-representation"&&ref.kind==="context_preparation_decision")referenceRevision=null;
    if(ref.owner==="material-source"&&ref.kind==="source_publication_closed"&&receipt.close) {
      const subject=contextProcessObject(ref.owner,ref.id,fact.runId,ref.revision);
      links.push(contextProcessRelationship("observes",subject,contextProcessObject("activity",ref.id,fact.runId)));
      closure={subject,kind:"source_publication_lifecycle",status:"closed"};
    }
  }
  return {links,referenceRevision,closure};
}

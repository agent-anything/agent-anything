import {modelInputValueDigest as digest,declareModelResultContentTextSlot,readModelResultContentTextSlot} from "@agent-anything/model-interaction/input";
import {containsMaterialRange,type MaterialCustodyPort,type MaterialReadPage,type MaterialAccess,type MaterialAccessDescription} from "@agent-anything/context/custody";
import type {RepresentationCatalogPort,RepresentationRecord} from "@agent-anything/context/representation";
import type {ContextSelectionSnapshot} from "@agent-anything/context/selection";
import type {TaskDecisionInputSources} from "@agent-anything/agent-runtime/decision";
import type {HelarcAgentOutput} from "../HelarcController.js";
import type {HelarcNativeRunTask} from "./HelarcNativeTaskExecution.js";
import {validateHelarcNativeResultPositions,type HelarcRetainedNativeInput} from "./HelarcNativeInputAcceptance.js";
import {helarcNativeTaskResultDeliveries} from "./HelarcNativeTaskResultDelivery.js";
import {helarcResultTextDeclaration} from "../../prompt/HelarcResultTextDeclaration.js";

export interface HelarcNativeResultSelectionPorts {
  readonly representations:RepresentationCatalogPort;
  readonly materials:MaterialCustodyPort;
  readonly maximumReadBytes:number;
}
/** Mechanical provenance check only; CRM's preservation and combination judgments remain indispensable. */
export async function validateHelarcNativeResultSelection(prepared:HelarcNativeRunTask,input:TaskDecisionInputSources<HelarcAgentOutput>,
  selected:ContextSelectionSnapshot,ports:HelarcNativeResultSelectionPorts):Promise<void>{
  const native=selected.input.exactInput as HelarcRetainedNativeInput,presentations=native.resultPresentations??[];
  if(presentations.length>128||!Number.isSafeInteger(ports.maximumReadBytes)||ports.maximumReadBytes<0||
    digest(presentations)!==digest(prepared.resultPresentations??[]))throw new TypeError("native_result_selection_invalid");
  validateHelarcNativeResultPositions(native);
  const deliveries=helarcNativeTaskResultDeliveries(prepared,input),wire=JSON.parse(prepared.wire.body);
  let readBytes=0;
  for(const presentation of presentations){
    const delivery=deliveries.find(d=>d.result.modelCallRef.id===presentation.slot.callId&&d.position===presentation.position);
    if(!delivery||
      !selected.selection.representations.some(r=>digest(r)===digest(presentation.representation)))throw new TypeError("native_result_representation_not_selected");
    const record=await ports.representations.command({kind:"read",ref:presentation.representation}) as RepresentationRecord|null;
    if(!record||digest(record.ref)!==digest(presentation.representation))throw new TypeError("native_result_representation_missing");
    const declaration=helarcResultTextDeclaration(delivery.result,"original","1");
    if(declaration?.source.kind==="retained_material"){
      const recipient={runId:selected.scope.runId,recipient:selected.scope.recipient,purpose:selected.scope.purpose};
      const original=await ports.materials.command({kind:"resolve_reference",reference:declaration.source.reference,recipient}) as MaterialAccessDescription;
      if(!original||!record.declaredCoverage.some(r=>containsMaterialRange(r,original.hold.range))||
        !record.inputs.some(i=>containsMaterialRange(i.material,original.hold.range))||
        !selected.input.holds.some(h=>digest(h.consumer)===digest(recipient)&&containsMaterialRange(h.range,original.hold.range)))
        throw new TypeError("native_result_original_report_not_retained");
    }
    const hold=selected.input.holds.find(h=>containsMaterialRange(h.range,record.body));
    if(!hold||hold.consumer.runId!==selected.scope.runId||hold.consumer.recipient!==selected.scope.recipient||hold.consumer.purpose!==selected.scope.purpose)
      throw new TypeError("native_result_representation_hold_missing");
    const size=record.body.end-record.body.start;
    if(size>ports.maximumReadBytes-readBytes)throw new TypeError("native_result_selection_read_limit");
    const access:MaterialAccess={id:`${selected.input.id}:result:${presentation.position}`,holdId:hold.id,recipient:hold.consumer,range:record.body},chunks:Buffer[]=[];
    for(let offset=record.body.start;offset<record.body.end;){
      const page=await ports.materials.command({kind:"read",access,offset,length:Math.min(65536,record.body.end-offset)}) as MaterialReadPage;
      if(page.start!==offset||page.end<=offset||page.end>record.body.end)throw new TypeError("native_result_representation_read_invalid");
      const bytes=Buffer.from(page.bytesBase64,"base64");if(bytes.length!==page.end-offset)throw new TypeError("native_result_representation_bytes_invalid");
      chunks.push(bytes);offset=page.end;readBytes+=bytes.length;
    }
    const text=new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks)),match=/^\/(input|messages)\/(\d+)$/.exec(delivery.position)!;
    const item=wire[match[1]!][Number(match[2])],value=JSON.parse(item.output??item.content),actual={...delivery.result,content:value.result};
    const slot=declareModelResultContentTextSlot(actual,presentation.slot.contentPath);
    if(text!==readModelResultContentTextSlot(actual,slot))throw new TypeError("native_result_representation_body_changed");
  }
}

import {snapshotProviderRequest, type ProviderRequest} from "@agent-anything/model-interaction";
import {modelInputValueDigest, type InputDuty, type ModelInputSection, type ModelInputSourceRef} from "@agent-anything/model-interaction/input";
import {validateOriginalResultTextDeclaration,type OriginalResultTextDeclaration} from "./OriginalResultTextDeclaration.js";
import {validateOriginalDataTextDeclaration,type OriginalDataTextDeclaration} from "./OriginalDataTextDeclaration.js";

export interface OriginalInputSourceGroup {
  readonly id:string;
  readonly revision:string;
  readonly owner:string;
  readonly occurrences:readonly {readonly position:number;readonly section:ModelInputSection}[];
  readonly duties:readonly InputDuty[];
  readonly sources:readonly ModelInputSourceRef[];
  readonly deliveries:readonly {readonly id:string;readonly sequence:number;readonly digest:string;readonly sectionId:string;readonly source:ModelInputSourceRef}[];
  readonly resultTexts?:readonly OriginalResultTextDeclaration[];
  readonly dataTexts?:readonly OriginalDataTextDeclaration[];
}
export interface OriginalInputSources {
  readonly id:string;
  readonly owner:string;
  readonly runId:string;
  readonly originalSourceId:string;
  readonly boundary:string;
  readonly request:ProviderRequest;
  readonly groups:readonly OriginalInputSourceGroup[];
}

/** Checks declared occurrences, not the meaning or truth of their content. */
export function validateOriginalInputSources(sources:OriginalInputSources):void {
  snapshotProviderRequest(sources.request);
  const sections=sources.request.composition.sections,positions=new Set<number>(),groups=new Set<string>(),sectionGroups=new Map<string,string>();
  if(!sources.id||!sources.owner||!sources.runId||!sources.originalSourceId||!sources.boundary)throw new TypeError("original_input_source_identity_missing");
  const deliveries=new Set<string>();
  for(const group of sources.groups) {
    if(!group.id||!group.owner||!group.revision||groups.has(group.id)||!group.occurrences.length)throw new TypeError("original_input_source_group_invalid");
    groups.add(group.id);
    for(const occurrence of group.occurrences) {
      const {position,section}=occurrence;
      if(!Number.isSafeInteger(position)||position<0||position>=sections.length||positions.has(position)||
        modelInputValueDigest(section)!==modelInputValueDigest(sections[position]))throw new TypeError("original_input_source_occurrence_invalid");
      positions.add(position);sectionGroups.set(section.id,group.id);
    }
    for(const delivery of group.deliveries) {
      const section=group.occurrences.find(o=>o.section.id===delivery.sectionId)?.section;
      if(!delivery.id||!delivery.digest||!Number.isSafeInteger(delivery.sequence)||delivery.sequence<0||deliveries.has(delivery.id)||
        !section||!delivery.source||![section.source,...section.provenance?.sources??[]].some(source=>
          modelInputValueDigest(source)===modelInputValueDigest(delivery.source)))throw new TypeError("original_input_source_delivery_invalid");
      deliveries.add(delivery.id);
    }
  }
  if(positions.size!==sections.length)throw new TypeError("original_input_source_coverage_missing");
  const declarations=new Set<string>();
  for(const group of sources.groups)for(const declaration of group.resultTexts??[]) {
    if(declarations.has(declaration.id)||!group.occurrences.some(o=>o.section.id===declaration.sectionId))throw new TypeError("original_result_text_declaration_invalid");
    declarations.add(declaration.id);validateOriginalResultTextDeclaration(sources,declaration);
  }
  for(const group of sources.request.composition.workingView.nativeGroups) {
    if(new Set(group.sectionIds.map(id=>sectionGroups.get(id))).size!==1)throw new TypeError("original_input_native_group_split");
  }
  for(const group of sources.groups)for(const declaration of group.dataTexts??[]) {
    if(declarations.has(declaration.id)||!group.occurrences.some(o=>o.section.id===declaration.sectionId))throw new TypeError("original_data_text_declaration_invalid");
    declarations.add(declaration.id);validateOriginalDataTextDeclaration(sources,declaration);
  }
}

/** Positions change with a request; immutable captured source bytes do not. */
export function originalInputSourceBytes(group:OriginalInputSourceGroup):Buffer {
  const body=originalInputDataBody(group);
  if(body!==null)return Buffer.from(body,"utf8");
  return Buffer.from(JSON.stringify({kind:"model_input_source",id:group.id,revision:group.revision,
    sections:group.occurrences.map(value=>value.section),sources:group.sources,duties:group.duties,deliveries:group.deliveries,
    ...(group.resultTexts?.length?{resultTexts:group.resultTexts}:{}),...(group.dataTexts?.length?{dataTexts:group.dataTexts}:{})}),"utf8");
}

/** The frozen original request retains the envelope; the material captures its explicitly delegated body. */
export function originalInputDataBody(group:OriginalInputSourceGroup):string|null {
  if(group.dataTexts?.length!==1||group.occurrences.length!==1)return null;
  const declaration=group.dataTexts[0]!,section=group.occurrences[0]!.section;
  if(section.id!==declaration.sectionId||section.content.kind!=="text"||section.role!=="user"||section.provenance?.author!=="host"||
    declaration.owner.owner!==group.owner||declaration.contentDigest!==modelInputValueDigest(section.content))
    throw new TypeError("original_data_body_binding_invalid");
  if(Buffer.from(section.content.text,"utf8").toString("utf8")!==section.content.text)throw new TypeError("original_data_body_utf8_invalid");
  return section.content.text;
}

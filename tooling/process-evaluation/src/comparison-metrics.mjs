// Uses the same fixed-watermark reduction as Inspector, not a second cost model.
export function comparisonMetricScope(inspections){
  const key=r=>`${r.sourceId}:${r.datasetId}`;
  const available=inspections.filter(i=>i.selection),latest=available.at(-1);
  if(!latest)return {recordings:[],limitations:["metric_recordings_unavailable"]};
  const recordings=[{...latest.selection,via:null}],selected=new Set([key(latest.selection)]);
  for(let index=0;index<recordings.length&&recordings.length<16;index++){
    const parent=available.find(i=>key(i.selection)===key(recordings[index]));
    for(const record of parent.records??[]){
      const target=record.payload.kind==="recording_link"?record.payload.target:null;
      if(!target||selected.has(key(target)))continue;
      const prior=available.find(i=>key(i.selection)===key(target));
      if(!prior)continue;
      recordings.push({...prior.selection,via:{sourceId:parent.selection.sourceId,datasetId:parent.selection.datasetId,recordId:record.id,linkId:null}});
      selected.add(key(target));if(recordings.length===16)break;
    }
  }
  const missing=inspections.filter(i=>!i.selection||!selected.has(key(i.selection)));
  const unavailableTargets=available.filter(i=>selected.has(key(i.selection))).flatMap(i=>(i.records??[])
    .filter(r=>r.payload.kind==="recording_link"&&r.payload.target&&!selected.has(key(r.payload.target))));
  return {recordings,limitations:[...(missing.length?[`metric_recordings_not_linked:${missing.length}`]:[]),
    ...(unavailableTargets.length?[`metric_linked_recordings_unavailable:${unavailableTargets.length}`]:[])]};
}

export async function captureComparisonMetrics(service,inspections,runIds,signal){
  let cursor,manifest;
  try{
    const scope=comparisonMetricScope(inspections);
    if(!scope.recordings.length)return {status:"unavailable",metrics:[],intervals:[],limitations:scope.limitations};
    const opened=await service.query({kind:"open_process_scope",recordings:scope.recordings});manifest=opened.process.manifest;
    let result;
    for(let page=0;page<512;page++){
      signal.throwIfAborted();result=(await service.query({kind:"advance_process_metrics",manifest,runIds,...(cursor?{cursor}:{}),limit:100})).measurement;
      cursor=result.cursor;if(!["collecting","reducing","intervals"].includes(result.status))break;
    }
    const metrics=[],intervals=[];
    for(const section of ["metrics","intervals"]){
      let after;
      for(let page=0;page<128;page++){
        signal.throwIfAborted();const read=(await service.query({kind:"read_process_metrics",manifest,runIds,cursor,section,...(after?{after}:{}),limit:100})).measurement;
        (section==="metrics"?metrics:intervals).push(...read[section]);after=read.next;if(!after)break;
        if(page===127)return {status:"limited",metrics,intervals,limitations:["capture_metric_page_bound"],manifest};
      }
    }
    return {status:scope.limitations.length&&result.status==="complete"?"partial":result.status,metrics,intervals,limitations:[...scope.limitations,...result.limitations],manifest};
  }catch(error){if(signal.aborted)throw error;return {status:"unavailable",metrics:[],intervals:[],limitations:[String(error)]};}
  finally{if(cursor)await service.query({kind:"release_process_metrics",manifest,runIds,cursor}).catch(()=>{});}
}

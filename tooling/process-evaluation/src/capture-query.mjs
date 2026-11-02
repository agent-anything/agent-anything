import {appendFile} from "node:fs/promises";
import {join} from "node:path";
export function observedCaptureQuery(service,directory){
  return {async query(query,signal){
    const started=performance.now();let result,failure;
    try{result=await service.query(query,signal);return result;}catch(error){failure=String(error);throw error;}
    finally{await appendFile(join(directory,"capture-queries.jsonl"),JSON.stringify({kind:query.kind,sourceId:query.sourceId??null,datasetId:query.datasetId??null,watermark:query.watermark??null,after:query.after??null,limit:query.limit??null,elapsedMs:performance.now()-started,records:result?.records?.length??null,failure:failure??null})+"\n");}
  }};
}

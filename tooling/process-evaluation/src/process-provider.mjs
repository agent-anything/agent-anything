import {createServer} from "node:http";
import {randomUUID} from "node:crypto";
import {appendFile,readFile} from "node:fs/promises";
import {join} from "node:path";
import {writeImmutable} from "./process-storage.mjs";

export async function mountProcessProvider(scope,directory,{respond,signal,maximumRequestBytes=1000000}){
  const previous=await readFile(join(directory,"endpoint.json"),"utf8").then(JSON.parse).catch(error=>{if(error.code==="ENOENT")return null;throw error;});
  const connection=await scope.acquire("evaluation-provider","connection",async()=>{
    const active=new Set(),handlers=new Set();let writes=Promise.resolve();
    const log=value=>writes=writes.then(()=>appendFile(join(directory,"provider.jsonl"),JSON.stringify(value)+"\n"));
    const server=createServer((request,response)=>{
      const id=`request-${randomUUID()}`,abort=new AbortController();active.add(abort);
      const handling=(async()=>{
        const start=performance.now(),chunks=[];let bytes=0;
        for await(const chunk of request){bytes+=chunk.length;if(bytes>maximumRequestBytes)throw new Error("request_capture_bound");chunks.push(chunk);}
        const raw=Buffer.concat(chunks).toString("utf8"),body=JSON.parse(raw);
        await log({kind:"request",id,at:new Date().toISOString(),body,bytes});
        await appendFile(join(directory,"provider-requests.jsonl"),JSON.stringify(body)+"\n");
        const result=await respond({body,raw,url:request.url,signal:AbortSignal.any([abort.signal,...(signal?[signal]:[])])});
        await log({kind:"server_response",id,at:new Date().toISOString(),elapsedMs:performance.now()-start,status:result.status,body:result.body});
        await appendFile(join(directory,"provider-responses.jsonl"),JSON.stringify(result.body)+"\n");
        response.writeHead(result.status,{"content-type":"application/json"});response.end(JSON.stringify(result.body));
      })().catch(async error=>{
        await log({kind:"transport_failure",id,at:new Date().toISOString(),message:String(error)});
        if(!response.destroyed){if(!response.headersSent)response.writeHead(500);response.end(JSON.stringify({error:String(error)}));}
      });
      handlers.add(handling);
      void handling.then(()=>{handlers.delete(handling);active.delete(abort);},()=>{active.delete(abort);});
    });
    await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(previous?.port??0,"127.0.0.1",resolve);});
    return {id:"evaluation-provider",kind:"connection",port:server.address().port,close:async()=>{
      for(const abort of active)abort.abort(new Error("evaluation_provider_closed"));
      server.closeAllConnections();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
      const outcomes=await Promise.allSettled([...handlers]);await writes;
      const failed=outcomes.find(outcome=>outcome.status==="rejected");if(failed)throw failed.reason;
    }};
  });
  signal?.throwIfAborted();
  if(!previous)await writeImmutable(join(directory,"endpoint.json"),{port:connection.port});
  return `http://127.0.0.1:${connection.port}`;
}

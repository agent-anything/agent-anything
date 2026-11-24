import {performance} from "node:perf_hooks";
import {cachedDataVersionTag} from "node:v8";
import {getPriority} from "node:os";

/** Fixed synthetic content, not application state or a model request. */
export function measureStorageContent(codec) {
  const samples=[];
  for(let iteration=0;iteration<8;iteration++) {
    const records=Object.freeze(Array.from({length:256},(_,index)=>Object.freeze({
      id:`source-${index}`,revision:1,sequence:index,
      request:Object.freeze({kind:"original",text:`source ${index} evidence `.repeat(20)}),
      result:Object.freeze({status:"accepted",positions:Object.freeze([index,index+1]),text:"retained result"}),
    })));
    const value=Object.freeze({kind:"probe",records,selected:records});
    const statistics=new codec.ExecutionContentStatistics(true);
    const encoder=new codec.ExecutionContentEncoder(undefined,statistics);
    const start=performance.now(),cpu=process.threadCpuUsage();
    const packed=encoder.pack(value);
    const encoded=performance.now(),encodeCpu=process.threadCpuUsage(cpu);
    const blocks=new Map(packed.blocks.map(block=>[block.id,block]));
    let reads=0;
    const decodeStart=performance.now(),decodeCpu=process.threadCpuUsage();
    const decoded=codec.unpackExecutionContent(packed,id=>{reads++;return blocks.get(id);},undefined,true);
    const decodeMs=performance.now()-decodeStart,used=process.threadCpuUsage(decodeCpu);
    if(JSON.stringify(decoded)!==JSON.stringify(value))throw new Error("storage_probe_round_trip_mismatch");
    samples.push({encodeMs:encoded-start,decodeMs,encodeCpuUs:encodeCpu.user+encodeCpu.system,
      decodeCpuUs:used.user+used.system,reads,bytes:packed.bytes,blocks:packed.blocks.length,...statistics.take()});
  }
  return {node:process.version,pid:process.pid,uptime:process.uptime(),priority:getPriority(),memory:process.memoryUsage(),codeCacheTag:cachedDataVersionTag(),flags:process.execArgv.filter(value=>value.startsWith("--conditions")||value==="--enable-source-maps"),samples};
}

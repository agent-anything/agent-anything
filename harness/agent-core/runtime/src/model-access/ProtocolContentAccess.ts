import {createHash} from "node:crypto";
import type {ProtocolContentRef,ProtocolExecutionJournal} from "./ProtocolExecutionJournal.js";

export interface ProtocolContentWork {readonly operation:"retain"|"read";readonly contentId:string;readonly activityId:string;readonly bytes:number;readonly pages:number;readonly elapsedMs:number}
const hash=(bytes:Uint8Array)=>`sha256:${createHash("sha256").update(bytes).digest("hex")}`;
/** Full-body access is explicit; metadata queries never call this utility. */
export async function readProtocolContent(journal:ProtocolExecutionJournal,content:ProtocolContentRef,activityId:string,
  maximumBytes:number,observe?:(work:ProtocolContentWork)=>void):Promise<Buffer>{
  if(!Number.isSafeInteger(maximumBytes)||maximumBytes<0||content.activityId!==activityId||!Number.isSafeInteger(content.bytes)||content.bytes<0||content.bytes>maximumBytes)throw new TypeError("protocol_content_read_scope_invalid");
  const start=performance.now(),parts:Buffer[]=[];let offset=0,pages=0;
  do{
    const value=await journal.command({kind:"content_read",content,activityId,offset,length:65536});
    if(!value||!("bytesBase64" in value)||typeof value.bytesBase64!=="string")throw new TypeError("protocol_content_page_invalid");
    const bytes=Buffer.from(value.bytesBase64,"base64"),end=offset+bytes.length;
    if(end>content.bytes||(value.next!==null&&value.next!==end)||(value.next===null&&end!==content.bytes)||(!bytes.length&&value.next!==null))throw new TypeError("protocol_content_page_invalid");
    parts.push(bytes);pages++;offset=end;if(value.next===null)break;
  }while(true);
  const result=Buffer.concat(parts);
  if(hash(result)!==content.digest)throw new TypeError("protocol_content_integrity_invalid");
  try{observe?.({operation:"read",contentId:content.id,activityId,bytes:result.length,pages,elapsedMs:performance.now()-start});}catch{}
  return result;
}
export async function retainProtocolContent(journal:ProtocolExecutionJournal,id:string,activityId:string,value:Uint8Array,
  observe?:(work:ProtocolContentWork)=>void):Promise<ProtocolContentRef>{
  const bytes=Buffer.from(value),start=performance.now();let pages=0;
  const content=Object.freeze({id,activityId,bytes:bytes.length,digest:hash(bytes)});
  await journal.command({kind:"content_begin",content});
  for(let offset=0;offset<bytes.length;offset+=65536){await journal.command({kind:"content_append",content,offset,bytesBase64:bytes.subarray(offset,offset+65536).toString("base64")});pages++;}
  await journal.command({kind:"content_complete",content});
  try{observe?.({operation:"retain",contentId:id,activityId,bytes:bytes.length,pages,elapsedMs:performance.now()-start});}catch{}
  return content;
}

import type {NativeModelSourceRef} from "@agent-anything/model-interaction/protocol";
import type {HelarcNativeTaskText} from "../../controller/native/HelarcNativeTaskContracts.js";
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:{};

/** Returned readable content only; encrypted or undisclosed reasoning is not text. */
export function nativeReadableReasoning(value:unknown,source:NativeModelSourceRef):readonly HelarcNativeTaskText[]{
  if(source.protocol.revision!=="1"||source.interpretation.revision!=="1"||source.interpretation.id!==`${source.protocol.id}.adapter`)return [];
  const v=object(value),out:HelarcNativeTaskText[]=[];
  const add=(pointer:string,text:unknown,identity=source.nativeIdentity)=>{
    if(typeof text==="string"&&text.length)out.push({text,source:{...source,position:{format:"json-pointer",value:pointer},nativeIdentity:identity}});
  };
  if(source.protocol.id==="openai.responses"&&Array.isArray(v.output)){
    for(const [i,item]of v.output.entries()){
      const r=object(item);if(r.type!=="reasoning"||typeof r.id!=="string")continue;
      for(const field of ["summary","content"]){
        const parts=r[field];if(!Array.isArray(parts))continue;
        for(const [j,part]of parts.entries()){
          const p=object(part);if(p.type==="summary_text"||p.type==="reasoning_text")add(`/output/${i}/${field}/${j}`,p.text,{kind:"reasoning",id:r.id});
        }
      }
    }
  }else if(source.protocol.id==="deepseek.chat-completions"&&Array.isArray(v.choices)){
    const c=v.choices.map(object).find(c=>c.index===0);add("/choices/0/message/reasoning_content",object(c?.message).reasoning_content);
  }else if(source.protocol.id==="ollama.chat")add("/message/thinking",object(v.message).thinking);
  return out;
}

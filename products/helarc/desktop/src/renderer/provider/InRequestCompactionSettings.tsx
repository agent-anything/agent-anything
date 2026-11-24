import * as React from "react";
import {useEffect,useRef,useState} from "react";
import {RotateCcw} from "lucide-react";
import type {ProviderCompactionPolicy} from "../../shared/ProviderCompactionPolicy.js";

export function InRequestCompactionSettings({policy,defaults,validate,onChange,onInvalid,onDirty}:{
  policy:ProviderCompactionPolicy;defaults:ProviderCompactionPolicy;
  validate(candidate:ProviderCompactionPolicy):Promise<ProviderCompactionPolicy>;
  onChange(policy:ProviderCompactionPolicy):void;onInvalid(invalid:boolean):void;onDirty():void;
}){
  const [text,setText]=useState(()=>JSON.stringify(policy,null,2)),[error,setError]=useState<string|null>(null);
  const revision=useRef(0);
  useEffect(()=>{onInvalid(false);return()=>{revision.current++;};},[]);
  async function edit(text:string){
    const version=++revision.current;onInvalid(true);
    setText(text);onDirty();
    try{
      const value=await validate(JSON.parse(text));
      if(revision.current!==version)return;
      if(value.target!==defaults.target)throw new TypeError("Policy target does not match this configuration.");
      setError(null);onInvalid(false);onChange(value);
    }catch(cause){if(revision.current!==version)return;setError(cause instanceof SyntaxError?"Invalid JSON":cause instanceof Error?cause.message:"Invalid policy");onInvalid(true);}
  }
  return <details><summary>In-request compaction use policy</summary>
    <dl><dt>Evidence</dt><dd>{policy.origin}</dd><dt>Support</dt><dd>{policy.support}</dd>
      <dt>Use profiles</dt><dd>{policy.profiles.length}</dd><dt>Reviewed</dt><dd>{policy.reviewedAt}</dd></dl>
    <label><span>Use policy (JSON)</span><textarea aria-label="In-request compaction use policy" spellCheck={false} rows={14}
      style={{width:"100%",minWidth:0,boxSizing:"border-box",fontFamily:"monospace",resize:"vertical"}} value={text}
      onChange={event=>void edit(event.target.value)} aria-invalid={error!==null}/></label>
    {error&&<p role="alert" className="settings-error">{error}</p>}
    <button type="button" className="secondary-button" title="Restore documentation defaults" onClick={()=>void edit(JSON.stringify(defaults,null,2))}>
      <RotateCcw size={14}/>Restore documentation defaults</button>
  </details>;
}

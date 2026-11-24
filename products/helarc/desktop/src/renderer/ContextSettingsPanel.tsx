import {useEffect,useState,type FormEvent} from "react";
import {Plus,Trash2,Save} from "lucide-react";
import type {HelarcDesktopApi,HelarcMainSnapshot,HelarcProviderProfileSnapshot} from "../shared/HelarcDesktopApi.js";
import type {HelarcContextCapabilityObservation,HelarcContextSettings,HelarcContextSettingsSnapshot} from "../shared/HelarcContextSettings.js";
import type {ProviderConfiguration} from "../shared/ProviderConfiguration.js";
import "./context-settings.css";

const dimensions:readonly [HelarcContextCapabilityObservation["dimensions"][number],string][]=[
  ["format_and_references","Format and references"],["source_support","Source support"],["coverage","Coverage"],
  ["exact_values_and_unknowns","Exact values and unknowns"],["revision_and_relationships","Revisions and relationships"],["misses_and_false_positives","Misses and false positives"]];
export function ContextSettingsPanel({api,snapshot}:{api:HelarcDesktopApi|null;snapshot:HelarcMainSnapshot}) {
  const [saved,setSaved]=useState<HelarcContextSettingsSnapshot|null>(null),[draft,setDraft]=useState<HelarcContextSettings|null>(null);
  const [profileId,setProfileId]=useState(snapshot.provider.activeProfile?.id??""),[error,setError]=useState<string|null>(null),[saving,setSaving]=useState(false);
  const [configurations,setConfigurations]=useState<readonly ProviderConfiguration[]>([]);
  useEffect(()=>{let active=true;api?.getContextSettings().then(value=>{if(active){setSaved(value);setDraft(value.settings);}}).catch(cause=>{if(active)setError(String(cause.message));});return()=>{active=false;};},[api]);
  useEffect(()=>{let active=true;void api?.providerConfigurations?.list().then(result=>{
    if(!active)return;if(result.ok)setConfigurations(result.value.configurations);else setError(result.code);
  }).catch(cause=>{if(active)setError(String(cause.message));});return()=>{active=false;};},[api]);
  const profile=snapshot.provider.profiles.find(p=>p.id===profileId);
  const configuration=configurations.find(c=>`native:${c.id}`===profileId);
  const change=(id:string,update:Partial<HelarcContextCapabilityObservation>)=>setDraft(current=>current&&({...current,observations:current.observations.map(item=>item.id===id?{...item,...update}:item)}));
  async function save(event:FormEvent) {
    event.preventDefault();if(!api||!saved||!draft)return;setSaving(true);setError(null);
    try {const result=await api.saveContextSettings({commandId:crypto.randomUUID(),settings:draft,expectedRevision:saved.revision});
      if(result.status!=="handled")throw new Error(result.code);setSaved(result.result);setDraft(result.result.settings);
    }catch(cause){setError((cause as Error).message);}finally{setSaving(false);}
  }
  return <form className="settings-panel context-settings" onSubmit={event=>void save(event)}>
    <h2>Context processing</h2>{error&&<p role="alert">{error}</p>}
    {draft&&<fieldset disabled={saving}>
      <label className="inspection-setting"><input type="checkbox" checked={draft.autoRepresentation} onChange={event=>setDraft({...draft,autoRepresentation:event.target.checked})}/><span>Automatic representation processing for new conversations</span></label>
      <h3>Capability observations</h3>
      <div className="context-observation-add"><label>Configuration<select value={profileId} onChange={event=>setProfileId(event.target.value)}><option value="">Select configuration</option>
        <optgroup label="Native protocol configurations">{configurations.map(c=><option key={c.id} value={`native:${c.id}`}>{c.name} / {c.model||"No model"}</option>)}</optgroup>
        <optgroup label="Earlier profiles">{snapshot.provider.profiles.map(p=><option key={p.id} value={p.id}>{p.displayName} / {p.model||"No model"}</option>)}</optgroup></select></label>
        <button type="button" disabled={!configuration?.model&&!profile?.model} onClick={()=>{
          const observation=configuration?newNativeObservation(configuration):profile?newObservation(profile):null;
          if(observation)setDraft({...draft,observations:[...draft.observations,observation]});
        }}><Plus size={16}/>Add observation</button></div>
      {draft.observations.map((item,index)=><section className="context-observation" key={item.id}>
        <header><h4>{index+1}. {item.target.model}</h4><button type="button" className="secondary-button" title="Remove observation" aria-label="Remove observation" onClick={()=>setDraft({...draft,observations:draft.observations.filter(value=>value.id!==item.id)})}><Trash2 size={16}/></button></header>
        <p className="context-observation-target">{"kind" in item.target?`${item.target.protocol.id} / ${item.target.configuration.revision}`:
          `${item.target.baseUrl} / ${item.target.modelSettings.thinking.mode}`}</p>
        <div className="context-observation-fields">
          <label>Purpose<select value={item.duty} onChange={e=>change(item.id,{duty:e.target.value as typeof item.duty})}><option value="generation">Generation</option><option value="assessment">Assessment</option></select></label>
          <label>Finding<select value={item.conclusion} onChange={e=>change(item.id,{conclusion:e.target.value as typeof item.conclusion})}><option value="unknown">Insufficient evidence</option><option value="supported">Positive observation</option><option value="limited">Known limitation</option><option value="conflicting">Conflicting evidence</option></select></label>
          <label>Method<select value={item.method?.id??""} onChange={e=>change(item.id,{method:e.target.value?{id:e.target.value,revision:"1"}:null})}><option value="">Unspecified</option>{["preserve","excerpt","detail","omit","summarize","restore","search","check","check_combination"].map(value=><option key={value} value={value}>{value}</option>)}</select></label>
          <label>Protocol<input value={item.protocol??""} onChange={e=>change(item.id,{protocol:e.target.value||null})}/></label>
          <label>Model artifact<input value={item.target.artifact??""} onChange={e=>change(item.id,{target:{...item.target,artifact:e.target.value||null}})}/></label>
          <label>Observed date<input type="date" value={item.observedAt.slice(0,10)} required onChange={e=>e.target.value&&change(item.id,{observedAt:`${e.target.value}T00:00:00Z`})}/></label>
        </div>
        <div className="context-observation-dimensions">{dimensions.map(([key,label])=><label key={key}><input type="checkbox" checked={item.dimensions.includes(key)} onChange={e=>change(item.id,{dimensions:e.target.checked?[...item.dimensions,key]:item.dimensions.filter(value=>value!==key)})}/>{label}</label>)}</div>
        {([['conditions','Material and sample conditions'],['finding','Observation'],['source','Source'],['limitations','Limitations and unknowns']] as const).map(([key,label])=><label className="context-observation-note" key={key}>{label}<textarea rows={2} value={item[key]} required={key==="finding"||key==="source"} onChange={e=>change(item.id,{[key]:e.target.value})}/></label>)}
      </section>)}
    </fieldset>}
    <button type="submit" disabled={!draft||saving}><Save size={16}/>{saving?"Saving...":"Save"}</button>
  </form>;
}
function newObservation(profile:HelarcProviderProfileSnapshot):HelarcContextCapabilityObservation {
  return {id:crypto.randomUUID(),revision:"",target:{profileId:profile.id,providerKind:profile.providerKind,baseUrl:profile.baseUrl,model:profile.model,
    modelSettings:profile.modelSettings??{service:profile.providerKind==="ollama"?"ollama":"generic",thinking:{mode:"default"}},contextWindowTokens:profile.ollamaRuntime?.contextWindowTokens??null,artifact:null},
    duty:"generation",method:null,protocol:null,conclusion:"unknown",dimensions:[],conditions:"",finding:"",source:"",limitations:"",observedAt:new Date().toISOString()};
}
function newNativeObservation(configuration:ProviderConfiguration):HelarcContextCapabilityObservation {
  return {id:crypto.randomUUID(),revision:"",target:{kind:"native_configuration",configuration:{id:configuration.id,revision:configuration.revision},
    protocol:{id:configuration.protocol,revision:"1"},model:configuration.model,semanticRevision:configuration.semanticRevision,artifact:null},
    duty:"generation",method:null,protocol:configuration.protocol,conclusion:"unknown",dimensions:[],conditions:"",finding:"",source:"",limitations:"",observedAt:new Date().toISOString()};
}

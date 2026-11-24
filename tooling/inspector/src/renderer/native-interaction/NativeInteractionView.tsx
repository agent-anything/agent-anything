import {useEffect,useState,useRef} from "react";
import {Alert,Button,Descriptions,Empty,Space,Table,Tag,Tabs} from "antd";
import {FileTextOutlined,InfoCircleOutlined} from "@ant-design/icons";
import type {InspectionRecord,InspectionSubjectRef} from "@agent-anything/inspection/records";
import type {InspectionSelection} from "@agent-anything/inspection/query";
import {inspectionQuery} from "../query-client/InspectorClient.js";

const protocols:Record<string,{name:string;outputs:string;transport:string}>={
  "openai.responses":{name:"OpenAI Responses",outputs:"Responses and Items",transport:"Events, retrieval and cancellation"},
  "deepseek.chat-completions":{name:"DeepSeek Chat Completions",outputs:"Choices and messages",transport:"Requests and chunks"},
  "ollama.chat":{name:"Ollama Chat",outputs:"Messages",transport:"Requests and chunks"},
};
export function NativeInteractionView({selection,records,selected,onSelect,onRecord,onContent}:{selection:InspectionSelection;
  records:readonly InspectionRecord[];selected:InspectionSubjectRef|null;onSelect:(s:InspectionSubjectRef)=>void;
  onRecord:(id:string)=>void;onContent:(id:string)=>void}){
  const [detailBinding,setDetailBinding]=useState<InspectionRecord|null>(null);
  const binding=records.find(r=>r.subject.id===selected?.id&&r.payload.kind==="native_interaction")??
    (detailBinding&&detailBinding.subject.id===selected?.id&&detailBinding.subject.datasetId===selection.datasetId?detailBinding:null);
  const p=binding?.payload.kind==="native_interaction"?binding.payload:null;
  const [facts,setFacts]=useState<readonly InspectionRecord[]>([]),[next,setNext]=useState<string|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[tab,setTab]=useState("all");
  const key=JSON.stringify([selection,selected]);
  const generation=useRef(0);
  const categories:Record<string,readonly string[]>={input:["binding","input","sent"],output:["output"],
    transport:["observation","event","dispatch_intent","reconciliation_intent","transport","control"],
    continuity:["continuation","continuity","history_disposition","owner_checkpoint"],
    accounting:["accounting","usage","measurement"],purpose:["purpose_accepted"],transformation:["transformation"],coverage:["coverage","capture"]};
  const filter=tab==="all"?{}:{nativeCategories:categories[tab]};
  useEffect(()=>{
    generation.current++;
    const abort=new AbortController();setFacts([]);setNext(null);setError(null);setDetailBinding(null);
    if(selected?.kind!=="model-activity"){setBusy(false);return;}
    setBusy(true);
    void inspectionQuery({...selection,kind:"get_native_interaction",subject:selected,limit:100,...filter},abort.signal)
      .then(r=>{if(!abort.signal.aborted){setFacts(r.records);setNext(r.next===null?null:String(r.next));setDetailBinding(r.relatedRecords?.find(f=>f.payload.kind==="native_interaction")??null);}})
      .catch(e=>{if(!abort.signal.aborted)setError(String(e.message));}).finally(()=>{if(!abort.signal.aborted)setBusy(false);});
    return()=>{generation.current++;abort.abort();};
  },[key,tab]);
  async function more(){
    if(!binding||!next||busy)return;setBusy(true);
    const current=generation.current;
    try{const r=await inspectionQuery({...selection,kind:"get_native_interaction",subject:binding.subject,limit:100,after:next,...filter});
      if(current!==generation.current)return;
      setFacts(old=>[...new Map([...old,...r.records].map(f=>[f.id,f])).values()]);setNext(r.next===null?null:String(r.next));}
    catch(e){if(current===generation.current)setError((e as Error).message);}finally{if(current===generation.current)setBusy(false);}
  }
  const protocol=p?protocols[p.protocol]:null;
  const shown=facts.filter(r=>r.payload.kind==="native_fact"&&(tab==="all"||categories[tab]?.includes(r.payload.category)));
  return <div className="native-interactions">
    <Table size="small" rowKey="id" pagination={false} scroll={{x:600}} dataSource={[...records]}
      rowClassName={r=>r.id===binding?.id?"record-selected":""} onRow={r=>({onClick:()=>onSelect(r.subject)})}
      columns={[
        {title:"Protocol",render:(_,r)=>r.payload.kind==="native_interaction"?<Button type="link" onClick={()=>onSelect(r.subject)}>{protocols[r.payload.protocol]?.name??r.payload.protocol}</Button>:null},
        {title:"Purpose",render:(_,r)=>r.payload.kind==="native_interaction"?r.payload.purpose:null},
        {title:"Model",render:(_,r)=>r.payload.kind==="native_interaction"?r.payload.model??"Unknown":null},
        {title:"Run / activity",render:(_,r)=><span className="break-id">{r.subject.runId}<small className="table-owner">{r.subject.id}</small></span>},
      ]}/>
    {!binding||!p?<Empty description="Select a native interaction"/>:<>
      <Descriptions size="small" column={1} items={[
        {key:"protocol",label:"Original protocol",children:`${protocol?.name??p.protocol} / ${p.protocolRevision}`},
        {key:"reader",label:"Original interpretation",children:`${p.interpretation} / ${p.interpretationRevision}`},
        {key:"recipient",label:"Recipient",children:<span className="break-id">{p.recipientId}</span>},
        {key:"composition",label:"Composition",children:<span className="break-id">{p.compositionDigest}</span>},
      ]}/>
      {error&&<Alert type="error" title={error}/>}
      <Tabs activeKey={tab} onChange={setTab} items={[
        ["all","All facts"],["input","Input and source mapping"],["output",protocol?.outputs??"Original output"],
        ["transport",protocol?.transport??"Transport"],["continuity","Continuity and recovery"],
        ["purpose","Purpose acceptance"],
        ["accounting","Usage and cost evidence"],["transformation","Compaction and transformations"],["coverage","Coverage"],
      ].map(([key,label])=>({key:key!,label}))}/>
      <Table size="small" loading={busy} rowKey="id" dataSource={shown} pagination={false} scroll={{x:650}} columns={[
        {title:"Commit",dataIndex:"commitSequence",width:75},
        {title:"Native fact",render:(_,r)=>r.payload.kind==="native_fact"?<span>{r.payload.nativeType}<small className="table-owner">{r.payload.nativeId??r.payload.position??r.payload.operationId}</small>{r.payload.details.length>0&&<dl className="native-fact-details">{r.payload.details.map(d=><div key={d.name}><dt>{d.name}</dt><dd>{d.value??"Unknown"}</dd></div>)}</dl>}</span>:null},
        {title:"State / coverage",render:(_,r)=>r.payload.kind==="native_fact"?<Space wrap><span>{r.payload.status??"Not stated"}</span><Tag>{r.payload.origin}</Tag>{r.payload.limitation&&<Tag color="warning">{r.payload.limitation}</Tag>}</Space>:null},
        {title:"Evidence",render:(_,r)=><Space wrap><Button aria-label="Fact and relations" icon={<InfoCircleOutlined/>} onClick={()=>onRecord(r.id)}>Fact and relations</Button>{r.contents.map(c=><Button key={c.id} aria-label={c.name} icon={<FileTextOutlined/>} onClick={()=>onContent(c.id)}>{c.name}</Button>)}</Space>},
      ]}/>
      {next&&<Button loading={busy} onClick={()=>{void more();}}>More native facts</Button>}
    </>}
  </div>;
}

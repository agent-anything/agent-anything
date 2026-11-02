import {useEffect, useState} from "react";
import {Alert, Button, Checkbox, Descriptions, Empty, Modal, Table, Tag, Tooltip} from "antd";
import {DownloadOutlined} from "@ant-design/icons";
import {readInspectionEvaluationReport, type InspectionEvaluationReport, type InspectionRecord} from "@agent-anything/inspection/records";
import type {InspectionReadManifest} from "@agent-anything/inspection/query";
import {inspectionQuery} from "../query-client/InspectorClient.js";

export function ProcessEvaluation({manifest,navigate}: {manifest:InspectionReadManifest;navigate(values:Record<string,string|null>):void}) {
  const [records,setRecords]=useState<InspectionRecord[]>([]),[selected,setSelected]=useState<InspectionRecord|null>(null);
  const [report,setReport]=useState<InspectionEvaluationReport|null>(null),[error,setError]=useState<string|null>(null),[loading,setLoading]=useState(false);
  const [page,setPage]=useState<Record<string,string|null>>({}),[next,setNext]=useState<Record<string,string|null>>({});
  const [exportOpen,setExportOpen]=useState(false),[authorized,setAuthorized]=useState(false);
  useEffect(()=>{
    const abort=new AbortController();setLoading(true);setError(null);
    void (async()=>{const rows:InspectionRecord[]=[],cursors:Record<string,string|null>={};
      for(const r of manifest.recordings){const key=`${r.sourceId}:${r.datasetId}`;if(page[key]===null)continue;
        const after=page[key];const read=await inspectionQuery({sourceId:r.sourceId,datasetId:r.datasetId,watermark:r.watermark,kind:"list_records",recordKind:"evaluation_report",limit:20,...(after?{after}:{})},abort.signal);
        rows.push(...read.records);cursors[key]=typeof read.next==="string"?read.next:null;}
      if(!abort.signal.aborted){setRecords(rows);setNext(cursors);}
    })().catch(e=>{if(!abort.signal.aborted)setError(e.message);}).finally(()=>{if(!abort.signal.aborted)setLoading(false);});
    return()=>abort.abort();
  },[JSON.stringify([manifest,page])]);
  async function readReport(record:InspectionRecord,signal?:AbortSignal){
    const content=record.contents.find(c=>c.stage==="evaluation-report"),selection=manifest.recordings.find(r=>r.sourceId===record.subject.sourceId&&r.datasetId===record.subject.datasetId);
    if(!content||!selection)throw new Error("Report content or fixed recording is unavailable");
    let text="",offset=0;
    do{const result=await inspectionQuery({kind:"get_process_content",manifest,location:{sourceId:selection.sourceId,datasetId:selection.datasetId,recordId:record.id,contentId:content.id},offset},signal);
      if(result.process?.contentAccess?.availability!=="available"||result.content?.descriptor.availability!=="present")throw new Error(result.process?.contentAccess?.availability??"Report unavailable");
      if(result.content.descriptor.truncated||result.content.descriptor.redacted)throw new Error("Report was truncated or redacted; full interpretation is unavailable");
      text+=result.content.text;if(text.length>1048576)throw new Error("Report exceeds the bounded viewer size");
      if(result.content.nextOffset===null)break;offset=result.content.nextOffset;
    }while(true);
    return readInspectionEvaluationReport(JSON.parse(text));
  }
  useEffect(()=>{
    const abort=new AbortController();setReport(null);setError(null);
    if(selected)void readReport(selected,abort.signal).then(value=>{if(!abort.signal.aborted)setReport(value);}).catch(e=>{if(!abort.signal.aborted)setError(e.message);});
    return()=>abort.abort();
  },[selected,JSON.stringify(manifest)]);
  async function evidence(target:InspectionEvaluationReport["trials"][number]["evidence"][number]){
    if(!selected)return;
    try{
      const link=selected.links.find(l=>l.to.sourceId===target.sourceId&&l.to.datasetId===target.datasetId);
      if(!link)throw new Error("Report has no recorded introduction for this evidence");
      const source=manifest.recordings.find(r=>r.sourceId===selected.subject.sourceId&&r.datasetId===selected.subject.datasetId)!;
      const same=source.sourceId===target.sourceId&&source.datasetId===target.datasetId;
      const opened=await inspectionQuery({kind:"open_process_scope",recordings:same?[{sourceId:source.sourceId,datasetId:source.datasetId,watermark:target.watermark,via:null}]:[{sourceId:source.sourceId,datasetId:source.datasetId,watermark:source.watermark,via:null},
        {sourceId:target.sourceId,datasetId:target.datasetId,watermark:target.watermark,via:{sourceId:source.sourceId,datasetId:source.datasetId,recordId:selected.id,linkId:link.id}}]});
      const original=await inspectionQuery({kind:"get_record",sourceId:target.sourceId,datasetId:target.datasetId,watermark:target.watermark,recordId:target.recordId});const record=original.records[0];
      if(!record)throw new Error("Original evidence is unavailable at the report watermark");
      navigate({cpManifest:JSON.stringify(opened.process!.manifest),cpView:"Decisions / Inputs",cpRuns:JSON.stringify(record.subject.runId?[record.subject.runId]:[]),
        cpFocus:JSON.stringify(record.payload.kind==="process_evidence"?record.payload.subject:record.subject),cpRecord:record.id,cpTab:"facts",cpPage:null,cpFocusPage:null});
    }catch(e){setError((e as Error).message);}
  }
  async function exportReport(){
    if(!authorized||!selected)return;
    try{const current=await readReport(selected),url=URL.createObjectURL(new Blob([JSON.stringify(current,null,2)],{type:"application/json"}));
      const anchor=document.createElement("a");anchor.href=url;anchor.download="evaluation-report.json";anchor.click();URL.revokeObjectURL(url);setExportOpen(false);setAuthorized(false);
    }catch(e){setError((e as Error).message);}
  }
  return <section className="process-evaluation" data-testid="process-evaluation">
    {error&&<Alert type="warning" title={error}/>}
    <Table tableLayout="fixed" rowKey="id" size="small" loading={loading} pagination={false} dataSource={records} columns={[
      {title:"Comparison / report",render:(_,r)=><Button type="link" onClick={()=>setSelected(r)}>{r.payload.kind==="evaluation_report"?`${r.payload.comparison} / ${r.payload.reportId}`:r.id}</Button>},
      {title:"Target / start",render:(_,r)=>r.payload.kind==="evaluation_report"?<>{r.payload.target}<br/>{r.payload.startingBoundary}</>:null},
      {title:"Coverage",render:(_,r)=>r.payload.kind==="evaluation_report"?`${r.payload.status}; ${r.payload.trialCount} trials; ${r.payload.limitationCount} limitations`:null},
    ]}/>
    <div className="view-toolbar">{Object.keys(page).length>0&&<Button onClick={()=>setPage({})}>First page</Button>}{Object.values(next).some(v=>v!==null)&&<Button onClick={()=>setPage({...page,...next})}>Next report page</Button>}</div>
    {!report?<Empty description={selected?"Report detail unavailable or loading":"Select a recorded evaluation report"}/>:<>
      <div className="view-toolbar"><h3>{report.comparison}: {report.id}</h3><Tooltip title="Export public report"><Button aria-label="Export evaluation report" icon={<DownloadOutlined/>} onClick={()=>{setAuthorized(false);setExportOpen(true);}}/></Tooltip></div>
      <Descriptions size="small" column={1} items={[
        {key:"target",label:"Target",children:report.target},{key:"start",label:"Starting boundary",children:report.startingBoundary},{key:"scope",label:"Scope",children:report.scope},
        {key:"expectations",label:"Expectations",children:report.expectations.join("; ")},{key:"exclusions",label:"Exclusions",children:report.exclusions.join("; ")||"None declared"},
        {key:"limits",label:"Limitations",children:report.limitations.join("; ")||"None recorded"},
      ]}/>
      {report.trials.map(trial=><section key={trial.id} className="process-path-group">
        <h4>{trial.arm} / repetition {trial.repetition}</h4><div className="view-toolbar"><Tag>Execution: {trial.execution}</Tag><Tag>Capture: {trial.capture}</Tag><Tag>Cleanup: {trial.cleanup}</Tag></div>
        <Table tableLayout="fixed" size="small" pagination={false} rowKey={(_,i)=>String(i)} dataSource={trial.grades} columns={[
          {title:"Dimension",dataIndex:"dimension",width:"18%"},{title:"Conclusion",dataIndex:"verdict",width:"20%"},{title:"Evaluator",dataIndex:"method",width:"16%"},{title:"Basis",dataIndex:"rationale"}]}/>
        <Table tableLayout="fixed" size="small" pagination={{pageSize:10,showSizeChanger:false,hideOnSinglePage:true}} rowKey={(_,i)=>String(i)} dataSource={trial.measurements} columns={[
          {title:"Measurement",dataIndex:"name"},{title:"Cost owner",dataIndex:"role"},{title:"Value",render:(_,m)=>m.value===null?`Unknown: ${m.unavailableReason}`:`${m.value} ${m.unit}`}]}/>
        <div className="view-toolbar">{trial.evidence.map(e=><Button key={`${e.datasetId}:${e.recordId}`} type="link" onClick={()=>void evidence(e)}>{e.label} @ {e.watermark}</Button>)}</div>
      </section>)}
    </>}
    <Modal title="Export evaluation report" open={exportOpen} onCancel={()=>setExportOpen(false)} onOk={()=>void exportReport()} okText="Export" okButtonProps={{disabled:!authorized}}>
      <Checkbox checked={authorized} onChange={e=>setAuthorized(e.target.checked)}>Authorize export of this public report, grades, metrics and evidence references. Private expectations and raw evidence are not included.</Checkbox>
    </Modal>
  </section>;
}

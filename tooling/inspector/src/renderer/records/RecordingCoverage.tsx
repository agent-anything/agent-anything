import {useState} from "react";
import {Button, Descriptions, Drawer, Table, Tag, Tooltip, Typography} from "antd";
import {InfoCircleOutlined} from "@ant-design/icons";
import type {InspectionCoverage, InspectionSubjectRef} from "@agent-anything/inspection/records";

export function RecordingCoverage({coverage, onRecord, onSubject}: {coverage: InspectionCoverage;
  onRecord: (id: string) => void; onSubject: (ref: InspectionSubjectRef) => void}) {
  const [open, setOpen] = useState(false);
  const progress = coverage.recording;
  const projection = progress?.projection;
  const pending = projection?.status === "active" && projection.cursor < progress!.native.target;
  const uncertain = coverage.limitations.some(value => value.includes("unknown") || value.includes("failed"));
  const inspect = (action: () => void) => {setOpen(false); action();};
  return <>
    {coverage.dropped + coverage.rejected > 0 && <Tag color="warning">Native capture gaps</Tag>}
    {pending && <Tag>Projection pending</Tag>}
    {projection?.status === "failed" && <Tag color="warning">Projection failed</Tag>}
    {coverage.telemetryDropped > 0 && <Tag color="warning">Telemetry limitations</Tag>}
    {uncertain && <Tag color="warning">Unconfirmed recording tail</Tag>}
    <Tooltip title="Recording completeness"><Button aria-label="Recording completeness" type="text" size="small"
      icon={<InfoCircleOutlined/>} onClick={() => setOpen(true)}/></Tooltip>
    <Drawer title="Recording completeness" open={open} onClose={() => setOpen(false)} size={600}
      styles={{wrapper: {maxWidth: "100vw"}, body: {overflowWrap: "anywhere"}}}>
      <Descriptions column={1} size="small" styles={{label: {whiteSpace: "normal"}, content: {minWidth: 0}}} items={[
        {key: "scope", label: "Scope", children: `Entire recording at snapshot ${coverage.watermark}`},
        {key: "status", label: "Writer", children: coverage.status},
        {key: "native", label: "Native records", children: `${coverage.captured} persisted; ${coverage.dropped} admission drops; ${coverage.rejected} rejected`},
        {key: "heartbeat", label: "Last committed health", children: coverage.heartbeat},
        ...(progress ? [
          {key: "accepted", label: "Admission", children: `${progress.ingress.accepted} accepted; health revision ${progress.ingress.revision}`},
          {key: "duplicates", label: "Exact duplicate offers", children: progress.native.duplicates},
          {key: "receipt", label: "Last durable batch", children: progress.native.lastReceipt ? `${progress.native.lastReceipt.firstSequence} - ${progress.native.lastReceipt.lastSequence}` : "None"},
          {key: "projection", label: "Derived projection", children: `${projection!.status}; handled prefix ${projection!.cursor}; native target ${progress.native.target}`},
          {key: "failure", label: "Projection failure", children: projection!.code ?? "None recorded"},
          {key: "flush", label: "Last completed flush", children: progress.lastFlush ? `Admission barrier ${progress.lastFlush.accepted}; projection ${progress.lastFlush.projection} through ${progress.lastFlush.projectionCursor}` : "None recorded"},
          {key: "highWater", label: "Ingress high-water marks", children: `${progress.ingress.highWater.records} records; ${progress.ingress.highWater.structureBytes} structure bytes; ${progress.ingress.highWater.contentBytes} content bytes`},
          {key: "timing", label: "Maximum observed durations", children: `Queue ${progress.ingress.timings.queueMaxMs.toFixed(1)} ms; native acknowledgement ${progress.ingress.timings.acknowledgementMaxMs.toFixed(1)} ms; projection slice ${projection!.sliceMaxMs.toFixed(1)} ms`},
        ] : []),
      ]}/>
      {coverage.limitations.length > 0 && <><Typography.Title level={5}>Recording limitations</Typography.Title>
        <ul>{coverage.limitations.map(value => <li key={value}>{value}</li>)}</ul></>}
      {!!progress?.ingress.issues.length && <><Typography.Title level={5}>Admission issues</Typography.Title>
        <Table size="small" pagination={false} rowKey="reason" scroll={{x: 420}} dataSource={[...progress.ingress.issues]} columns={[
          {title: "Reason", dataIndex: "reason"}, {title: "Count", dataIndex: "count"},
          {title: "Ingress range", render: (_, issue) => `${issue.firstSequence ?? "unknown"} - ${issue.lastSequence ?? "unknown"}`},
        ]} expandable={{expandedRowRender: issue => <>
          <p>{issue.firstAt} to {issue.lastAt}. {issue.coalesced ? "Bounded samples; intervening attribution not retained." : "Recorded samples:"}</p>
          {issue.samples.map((sample, index) => sample.subject ? <Button key={index} type="link" onClick={() => inspect(() => onSubject(sample.subject!))}>
            {sample.subject.owner} / {sample.subject.kind} / {sample.sequence}</Button> : <span key={index}>Unknown source </span>)}
        </>}}/>
      </>}
      {!!projection?.issues.length && <><Typography.Title level={5}>Projection issues</Typography.Title>
        <Table size="small" pagination={false} rowKey="reason" dataSource={[...projection.issues]} columns={[
          {title: "Reason", dataIndex: "reason"}, {title: "Count", dataIndex: "count"},
        ]} expandable={{expandedRowRender: issue => <>
          {issue.coalesced && <p>Source record links are bounded samples.</p>}
          {issue.recordIds.map(id => <Button type="link" key={id} onClick={() => inspect(() => onRecord(id))}>{id}</Button>)}
        </>}}/>
      </>}
    </Drawer>
  </>;
}

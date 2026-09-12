import { randomUUID } from "node:crypto";
import { ROOT_CONTEXT, trace, SpanStatusCode, type Span, type SpanContext } from "@opentelemetry/api";
import { ExportResultCode } from "@opentelemetry/core";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { AlwaysOnSampler, BasicTracerProvider, SimpleSpanProcessor, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { LoggerProvider, SimpleLogRecordProcessor, type LogRecordExporter } from "@opentelemetry/sdk-logs";
import { inspectionSubjectKey, type InspectionRecord } from "../records/index.js";
import type { InspectionTelemetryWrite } from "../storage/index.js";

/** Private SDKs project committed native facts; they never instrument execution. */
export class InspectionTelemetry {
  private readonly traces: BasicTracerProvider;
  private readonly logs: LoggerProvider;
  private readonly open = new Map<string, { span: Span; record: InspectionRecord }>();
  private readonly runs = new Map<string, SpanContext>();
  private readonly queue: InspectionTelemetryWrite[] = [];
  private queuedBytes = 0;
  dropped = 0;

  constructor(sourceId: string, datasetId: string) {
    const resource = resourceFromAttributes({ "service.name": "agent-inspection", "inspection.source_id": sourceId, "inspection.dataset_id": datasetId });
    const enqueue = (kind: "span" | "log", attributes: Record<string, unknown>, value: unknown, traceId?: string, spanId?: string) => {
      const data = JSON.stringify(value);
      const size = Buffer.byteLength(data);
      if (this.queue.length >= 2048 || this.queuedBytes + size > 8 * 1024 * 1024) { this.dropped++; return; }
      this.queue.push({ id: randomUUID(), kind, recordId: String(attributes["inspection.record_id"]), subjectKey: String(attributes["inspection.subject_key"]), traceId: traceId ?? null, spanId: spanId ?? null, data });
      this.queuedBytes += size;
    };
    const spanExporter: SpanExporter = {
      export: (spans, done) => {
        try {
          for (const span of spans) {
            const context = span.spanContext();
            enqueue("span", span.attributes, { name: span.name, context, parentSpanContext: span.parentSpanContext ?? null, startTime: span.startTime, endTime: span.endTime, status: span.status, attributes: span.attributes, links: span.links, resource: span.resource.attributes }, context.traceId, context.spanId);
          }
          done({ code: ExportResultCode.SUCCESS });
        } catch { this.dropped += spans.length; done({ code: ExportResultCode.FAILED }); }
      },
      shutdown: async () => {},
    };
    const logExporter: LogRecordExporter = {
      export: (logs, done) => {
        try {
          for (const log of logs) enqueue("log", log.attributes, { timestamp: log.hrTime, body: log.body, attributes: log.attributes, context: log.spanContext ?? null, resource: log.resource.attributes }, log.spanContext?.traceId, log.spanContext?.spanId);
          done({ code: ExportResultCode.SUCCESS });
        } catch { this.dropped += logs.length; done({ code: ExportResultCode.FAILED }); }
      },
      forceFlush: async () => {}, shutdown: async () => {},
    };
    this.traces = new BasicTracerProvider({ resource, sampler: new AlwaysOnSampler(), spanProcessors: [new SimpleSpanProcessor(spanExporter)], spanLimits: { attributeCountLimit: 32, attributeValueLengthLimit: 4096, eventCountLimit: 0, linkCountLimit: 32 } });
    this.logs = new LoggerProvider({ resource, processors: [new SimpleLogRecordProcessor({ exporter: logExporter })], logRecordLimits: { attributeCountLimit: 32, attributeValueLengthLimit: 4096 } });
  }

  accept(record: InspectionRecord): void {
    try {
      const key = inspectionSubjectKey(record.subject);
      const attributes = { "inspection.record_id": record.id, "inspection.subject_key": key, "inspection.commit_sequence": record.commitSequence, "inspection.kind": record.payload.kind, "inspection.owner": record.subject.owner };
      const runKey = `${record.subject.sourceId}:${record.subject.datasetId}:${record.subject.runId ?? record.subject.id}`;
      const runContext = this.runs.get(runKey);
      const context = runContext ? trace.setSpanContext(ROOT_CONTEXT, runContext) : ROOT_CONTEXT;
      if (record.payload.kind === "flow_invocation" && record.occurredAt !== null) {
        const fact = record.payload.observation;
        const flowKey = `flow:${fact.invocationId}`;
        if (fact.kind === "invocation_entered") {
          if (this.open.has(flowKey) || this.open.size >= 2048) { this.dropped++; return; }
          const caller = fact.caller ? this.open.get(`flow:${fact.caller.invocationId}`)?.span.spanContext() : undefined;
          const parent = caller ? trace.setSpanContext(ROOT_CONTEXT, caller) : context;
          const span = this.traces.getTracer("inspection.native", "2").startSpan(`${fact.definition.owner}.${fact.definition.id}`, {startTime: new Date(record.occurredAt), attributes: {...attributes, "inspection.flow_invocation_id": fact.invocationId, "inspection.flow_revision": fact.definition.revision}}, parent);
          this.open.set(flowKey, {span, record});
        } else {
          const active = this.open.get(flowKey);
          if (!active) { this.dropped++; return; }
          active.span.setAttributes({...attributes, "inspection.start_record_id": active.record.id, "inspection.native_disposition": fact.disposition});
          if (fact.disposition === "failed") active.span.setStatus({code: SpanStatusCode.ERROR});
          active.span.end(new Date(record.occurredAt));
          this.open.delete(flowKey);
        }
      } else if (record.payload.kind === "interval" && record.occurredAt !== null) {
        const intervalKey = `${key}:${record.payload.activity}`;
        if (record.payload.phase === "started") {
          if (this.open.has(intervalKey) || this.open.size >= 2048) { this.dropped++; return; }
          const links = record.links.filter((link) => link.kind === "descendant").flatMap((link) => {
            const parent = this.runs.get(`${link.from.sourceId}:${link.from.datasetId}:${link.from.runId ?? link.from.id}`);
            return parent ? [{ context: parent }] : [];
          });
          const span = this.traces.getTracer("inspection.native", "1").startSpan(`${record.subject.owner}.${record.payload.activity}`, { startTime: new Date(record.occurredAt), attributes, links }, record.payload.activity === "run" ? ROOT_CONTEXT : context);
          if (record.payload.activity === "run") {
            if (this.runs.size >= 2048) this.runs.delete(this.runs.keys().next().value!);
            this.runs.set(runKey, span.spanContext());
          }
          this.open.set(intervalKey, { span, record });
        } else {
          const active = this.open.get(intervalKey);
          if (!active) { this.dropped++; return; }
          active.span.setAttributes({ ...attributes, "inspection.start_record_id": active.record.id, "inspection.native_status": record.payload.status ?? "unknown" });
          if (record.payload.status === "failed") active.span.setStatus({ code: SpanStatusCode.ERROR });
          else if (record.payload.status === "succeeded" || record.payload.status === "completed") active.span.setStatus({ code: SpanStatusCode.OK });
          active.span.end(new Date(record.occurredAt));
          this.open.delete(intervalKey);
        }
      } else {
        this.logs.getLogger("inspection.native", "1").emit({ context, timestamp: new Date(record.occurredAt ?? record.capturedAt), body: record.payload.kind, attributes });
      }
    } catch { this.dropped++; }
  }

  async flush(write: (record: InspectionTelemetryWrite) => void): Promise<void> {
    try { await this.traces.forceFlush(); } catch { this.dropped++; }
    try { await this.logs.forceFlush(); } catch { this.dropped++; }
    for (const item of this.queue.splice(0)) {
      try { write(item); } catch { this.dropped++; }
    }
    this.queuedBytes = 0;
  }

  async close(write: (record: InspectionTelemetryWrite) => void): Promise<void> {
    // Unfinished spans are not ended synthetically; native ongoing records survive.
    this.dropped += this.open.size;
    this.open.clear();
    this.runs.clear();
    await this.flush(write);
    try { await this.traces.shutdown(); } catch { this.dropped++; }
    try { await this.logs.shutdown(); } catch { this.dropped++; }
  }
}

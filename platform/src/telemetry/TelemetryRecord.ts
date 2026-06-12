import type { ISODateTimeString, Metadata } from "../shared/types.js";

export type TelemetryCounters = Record<string, number>;
export type TelemetryDimensionValue = string | number | boolean | null;
export type TelemetryDimensions = Record<string, TelemetryDimensionValue>;

export interface TelemetryRecord {
  id: string;
  taskId: string | null;
  eventName: string;
  timestamp: ISODateTimeString;
  durationMs: number | null;
  counters: TelemetryCounters;
  dimensions: TelemetryDimensions;
  metadata: Metadata;
}

export interface CreateTelemetryRecordInput {
  id: string;
  taskId?: string | null;
  eventName: string;
  timestamp: ISODateTimeString;
  durationMs?: number | null;
  counters?: TelemetryCounters;
  dimensions?: TelemetryDimensions;
  metadata?: Metadata;
}

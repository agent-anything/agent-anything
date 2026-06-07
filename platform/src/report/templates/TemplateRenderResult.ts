import type { Metadata } from "../../shared/types.js";
import type { Report } from "../Report.js";

export type TemplateRenderStatus = "succeeded" | "failed";

export type TemplateRenderResult =
  | TemplateRenderSucceeded
  | TemplateRenderFailed;

export interface TemplateRenderSucceeded {
  status: "succeeded";
  report: Report;
  error: null;
  metadata: Metadata;
}

export interface TemplateRenderFailed {
  status: "failed";
  report: null;
  error: TemplateRenderError;
  metadata: Metadata;
}

export interface TemplateRenderError {
  code: string;
  message: string;
  metadata?: Metadata;
}

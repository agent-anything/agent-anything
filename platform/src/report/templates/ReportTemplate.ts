import type { Metadata } from "../../shared/types.js";
import type { ReportSection } from "../ReportSection.js";
import type { TemplateRenderInput } from "./TemplateRenderInput.js";

export interface ReportTemplateOutput {
  title: string;
  sections: ReportSection[];
  metadata?: Metadata;
}

export interface ReportTemplate {
  id: string;
  render(input: TemplateRenderInput): ReportTemplateOutput | Promise<ReportTemplateOutput>;
}

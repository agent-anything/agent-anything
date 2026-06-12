import type { ReportTemplate } from "./ReportTemplate.js";

export class ReportTemplateRegistry {
  private readonly templates = new Map<string, ReportTemplate>();

  register(template: ReportTemplate): void {
    if (this.templates.has(template.id)) {
      throw new Error(`Report template '${template.id}' is already registered.`);
    }

    this.templates.set(template.id, template);
  }

  get(templateId: string): ReportTemplate | undefined {
    return this.templates.get(templateId);
  }

  has(templateId: string): boolean {
    return this.templates.has(templateId);
  }

  list(): ReportTemplate[] {
    return [...this.templates.values()];
  }
}

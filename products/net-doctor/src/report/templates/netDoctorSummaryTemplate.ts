import type { ReportTemplate } from "./ReportTemplate.js";
import {
  createEvidenceSummary,
  getEvidenceRefs,
  getFinalDiagnosis,
  getSymptom,
  getTargetLabel,
} from "./templateHelpers.js";

export const netDoctorSummaryTemplate: ReportTemplate = {
  id: "net-doctor.summary",
  render(input) {
    const evidenceRefs = getEvidenceRefs(input.evidence);
    const target = getTargetLabel(input);

    return {
      title: `NetDoctor diagnosis for ${target}`,
      sections: [
        {
          title: "Diagnosis",
          content: [
            `Target: ${target}`,
            `Symptom: ${getSymptom(input)}`,
            `Conclusion: ${getFinalDiagnosis(input.finalOutput)}`,
          ].join("\n"),
          evidenceRefs,
          metadata: {
            sectionKind: "netDoctor.diagnosis",
          },
        },
        {
          title: "Evidence Summary",
          content: createEvidenceSummary(input.evidence),
          evidenceRefs,
          metadata: {
            sectionKind: "netDoctor.evidenceSummary",
          },
        },
      ],
      metadata: {
        product: "net-doctor",
        template: "summary",
      },
    };
  },
};

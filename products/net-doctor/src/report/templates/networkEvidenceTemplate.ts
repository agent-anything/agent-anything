import type { Evidence } from "@agent-anything/evidence";
import type { NetDoctorReportSection, ReportTemplate } from "./ReportTemplate.js";
import {
  createEvidenceSummary,
  getEvidenceKind,
  getTargetLabel,
  toEvidenceTitle,
} from "./templateHelpers.js";

export const networkEvidenceTemplate: ReportTemplate = {
  id: "net-doctor.network-evidence",
  render(input) {
    return {
      title: `NetDoctor network evidence for ${getTargetLabel(input)}`,
      sections: createNetworkEvidenceSections(input.evidence),
      metadata: {
        product: "net-doctor",
        template: "network-evidence",
      },
    };
  },
};

function createNetworkEvidenceSections(evidence: Evidence[]): NetDoctorReportSection[] {
  if (evidence.length === 0) {
    return [
      {
        title: "Network evidence",
        content: "No evidence was produced.",
        evidenceRefs: [],
        metadata: {
          evidenceKind: "none",
        },
      },
    ];
  }

  return groupEvidence(evidence).map(([evidenceKind, items]) => ({
    title: toEvidenceTitle(evidenceKind),
    content: createEvidenceSummary(items),
    evidenceRefs: items.map((item) => item.id),
    metadata: {
      evidenceKind,
      sensitivities: [...new Set(items.map((item) => item.sensitivity))],
    },
  }));
}

function groupEvidence(evidence: Evidence[]): Array<[string, Evidence[]]> {
  const groups = new Map<string, Evidence[]>();

  for (const item of evidence) {
    const evidenceKind = getEvidenceKind(item);
    groups.set(evidenceKind, [...(groups.get(evidenceKind) ?? []), item]);
  }

  return [...groups.entries()];
}

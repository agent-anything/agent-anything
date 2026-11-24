const versions={
  "1":{procedure:"legacy",requiresInputAdmission:false},
  "2":{procedure:"legacy",requiresInputAdmission:true},
  "3":{procedure:"scoped_checks.v1",requiresInputAdmission:true},
  "4":{procedure:"preservation_facts.v1",requiresInputAdmission:true},
  "5":{procedure:"source_and_use.v1",requiresInputAdmission:true},
  "6":{procedure:"source_and_use.v2",requiresInputAdmission:true},
  "7":{procedure:"source_and_use.v3",requiresInputAdmission:true},
} as const;
export const currentCompactAssessmentRevision="7" satisfies keyof typeof versions;
export const compactAssessmentRevisions=Object.keys(versions);
export function compactAssessmentVersion(revision:string){
  if(!Object.hasOwn(versions,revision))throw new TypeError("compact_assessment_revision_unknown");
  return versions[revision as keyof typeof versions];
}

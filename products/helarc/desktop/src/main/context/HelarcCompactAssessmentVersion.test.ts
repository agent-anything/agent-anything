import {expect,it} from "vitest";
import {compactAssessmentVersion as get,compactAssessmentRevisions,currentCompactAssessmentRevision} from "./HelarcCompactAssessmentVersion.js";

it("preserves the accepted procedure and admission contract for each frozen composition",()=>{
  expect(compactAssessmentRevisions.map(r=>[r,get(r).procedure,get(r).requiresInputAdmission])).toEqual([
    ["1","legacy",false],["2","legacy",true],["3","scoped_checks.v1",true],
    ["4","preservation_facts.v1",true],["5","source_and_use.v1",true],["6","source_and_use.v2",true],["7","source_and_use.v3",true],
  ]);
  expect(get(currentCompactAssessmentRevision).requiresInputAdmission).toBe(true);
  expect(()=>get("unknown")).toThrow("compact_assessment_revision_unknown");
});

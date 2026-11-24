import {describe,it,expect} from "vitest";
import {assessTransformationQuality,type TransformationFinding,type TransformationDuty} from "./TransformationQuality.js";
const dependencies={recipient:"parent",target:"model:1",authority:"allow:1",source:"s1",requirements:"r1",method:"compact:1"};
const duty:TransformationDuty={id:"method",revision:"1",requirement:"semantic",permittedEvidence:["method_assurance","continuation_probe"]};
const finding:TransformationFinding={id:"assurance",dutyId:duty.id,dutyRevision:duty.revision,kind:"method_assurance",conclusion:"supported",
  dependencies,subject:"candidate",evidence:["calibrated-retention:1"],limitations:["Not a direct semantic check"]};
const assess=(duties=[duty],findings:TransformationFinding[]=[finding])=>assessTransformationQuality({subject:"candidate",dependencies,duties,findings});
describe("scoped transformation quality",()=>{
  it("keeps unknown unknown and distinguishes method assurance from direct inspection",()=>{
    expect(assess([duty],[]).allowed).toBe(false);expect(assess().duties[0].basis).toBe("method_assurance");
    expect(assess().limitations).toContain("Not a direct semantic check");
  });
  it.each(["recipient","target","authority","source","requirements","method"] as const)("does not reuse a judgment after %s changes",key=>{
    expect(assess([duty],[{...finding,dependencies:{...dependencies,[key]:"new"}}]).allowed).toBe(false);
  });
  it("cannot offset a failed duty with savings or protocol success",()=>{
    expect(assess([duty],[finding,{...finding,id:"failed",conclusion:"unsupported"}]).allowed).toBe(false);
  });
  it("rejects assurance or contaminated probes as proof of exact preservation",()=>{
    expect(assess([{...duty,requirement:"exact"}]).allowed).toBe(false);
    const probe:TransformationFinding={...finding,kind:"continuation_probe",probe:{candidateDigest:"candidate",independentOracle:"oracle",answerBearingBackground:true}};
    expect(assess([duty],[probe]).allowed).toBe(false);
    expect(assess([duty],[{...probe,probe:{...probe.probe!,answerBearingBackground:false}}]).allowed).toBe(true);
  });
});

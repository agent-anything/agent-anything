import {it,expect} from "vitest";
import {readInspectionEvaluationReport} from "./InspectionEvaluationReport.js";
const report=()=>({version:"1",id:"report",comparison:"C01",target:"target",startingBoundary:"before_adoption",scope:"fixed",expectations:[],exclusions:[],limitations:[],trials:[{id:"trial",arm:"a",repetition:1,execution:"completed",capture:"partial",cleanup:"cleaned",grades:[],measurements:[{name:"cost",role:"target",unit:"currency",value:null,unavailableReason:"no tariff"}],evidence:[{sourceId:"s",datasetId:"d",recordId:"r",watermark:3,label:"Original"}]}]});
it("accepts explicit unknown measurements and fixed original evidence watermarks",()=>{expect(readInspectionEvaluationReport(report()).trials[0]!.evidence[0]!.watermark).toBe(3);});
it("rejects undeclared private bodies at every export level",()=>{
  expect(()=>readInspectionEvaluationReport({...report(),privateExpectations:{answer:42}})).toThrow();
  const r=report();expect(()=>readInspectionEvaluationReport({...r,trials:[{...r.trials[0],rawRequest:"private"}]})).toThrow();
});
it("does not accept unknown costs as non-finite numbers",()=>{const r=report();r.trials[0]!.measurements[0]!.value=NaN as never;expect(()=>readInspectionEvaluationReport(r)).toThrow();});

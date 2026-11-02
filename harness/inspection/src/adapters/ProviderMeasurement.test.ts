import {expect,it} from "vitest";
import type {ProviderObservation} from "@agent-anything/model-interaction/transport";
import type {InspectionRecorder} from "../recording/index.js";
import {providerMeasurement} from "./ProviderMeasurement.js";
import {validWorkMeasurement,inspectionMeasurementObservationOrigin} from "../records/index.js";
const recorder={ref:(owner:string,kind:string,id:string,runId:string|null)=>({owner,kind,id,runId,revision:null,sourceId:"source",datasetId:"dataset"})} as unknown as InspectionRecorder;
const observation:ProviderObservation={attemptId:"physical",requestId:"request",runId:"root",controllerRequestId:null,providerId:"provider",model:"model",occurredAt:"2026-11-01T00:00:00Z",
  stage:"settled",endpoint:null,httpStatus:200,encodedBytes:null,code:null,status:"succeeded",request:null,body:null,representation:"normalized",contentUnavailable:false,
  result:{kind:"succeeded",response:{kind:"text_generation",output:"not a metric",responseId:null,continuation:null,metadata:{},usage:{inputTokens:100,outputTokens:20,totalTokens:120,costUnits:null,metadata:{accountingRevision:"v1",accountingConsistent:true,cachedInputTokens:40}}}}};
it("adapts authoritative usage without treating cache hits as additional input or guessing prices",()=>{
  const record=providerMeasurement(recorder,observation)!;expect(record.payload.kind).toBe("work_measurement");
  if(record.payload.kind!=="work_measurement")throw new Error();
  const {kind:_,...value}=record.payload;expect(validWorkMeasurement(value)).toBe(true);
  expect(value.data).toMatchObject({kind:"attempt",boundary:"settled",price:null,usage:{inputTokens:100,cacheReadTokens:40,cacheWriteTokens:null,cacheRelation:"input_subsets"}});
  const bound=providerMeasurement(recorder,{...observation,stage:"request",result:null})!;
  if(bound.payload.kind!=="work_measurement")throw new Error();
  expect(bound.payload.origin).toEqual(value.origin);expect(inspectionMeasurementObservationOrigin(bound.payload)).not.toEqual(inspectionMeasurementObservationOrigin(value));
  expect(providerMeasurement(recorder,{...observation,stage:"response_body"})).toBeNull();
});
it("leaves usage absent on failed or unconfirmed exchanges",()=>{
  const record=providerMeasurement(recorder,{...observation,status:"failed",result:{kind:"failed",failure:{category:"network",code:"offline",message:"Offline",metadata:{}}}})!;
  expect(record.payload).toMatchObject({data:{status:"failed",usage:null,price:null}});
});

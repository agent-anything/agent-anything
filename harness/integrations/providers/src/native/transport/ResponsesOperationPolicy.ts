import { copy, NativeProtocolError } from "../NativeJson.js";

export interface ResponsesObservationPolicy {
  readonly connectMs:number;readonly readMs:number;readonly silenceMs:number;
  readonly pollMinimumMs:number;readonly pollMaximumMs:number;
  readonly failureRetries:number;readonly failureEpisodeMs:number;
}
export interface ResponsesFailureEpisode {
  readonly startedAt:number;readonly deadlineAt:number;readonly failures:number;
  readonly dueAt:number;readonly exhausted:boolean;readonly reason:string;
}
export const DEFAULT_RESPONSES_OBSERVATION_POLICY:ResponsesObservationPolicy=Object.freeze({
  connectMs:15000,readMs:30000,silenceMs:120000,pollMinimumMs:1000,pollMaximumMs:10000,failureRetries:3,failureEpisodeMs:120000,
});
export function validateResponsesObservationPolicy(value:ResponsesObservationPolicy):void {
  for(const [key,number] of Object.entries(value))if(!Number.isSafeInteger(number)||number<(key==="failureRetries"?0:1)||number>86400000)
    throw new NativeProtocolError("responses_observation_policy_invalid");
  if(value.failureRetries>10||value.pollMinimumMs>value.pollMaximumMs)throw new NativeProtocolError("responses_observation_policy_invalid");
}
export function responsesReadFailure(input:{readonly previous:ResponsesFailureEpisode|null;readonly policy:ResponsesObservationPolicy;
  readonly now:number;readonly startedAt?:number;readonly lifetime:number;readonly retryAfter:string|null;readonly reason:string;readonly retryable:boolean;readonly jitter:number}):ResponsesFailureEpisode {
  const {policy,previous,now}=input;validateResponsesObservationPolicy(policy);
  if(!Number.isFinite(now)||!Number.isFinite(input.lifetime)||input.jitter<0||input.jitter>1)throw new NativeProtocolError("responses_clock_or_jitter_invalid");
  const failures=(previous?.failures??0)+1,startedAt=previous?.startedAt??input.startedAt??now,deadlineAt=Math.min(previous?.deadlineAt??startedAt+policy.failureEpisodeMs,input.lifetime);
  const delay=Math.min(policy.pollMaximumMs,1000*2**Math.min(failures-1,10))*(0.8+0.4*input.jitter);
  const retry=retryAfterMs(input.retryAfter,now);
  const dueAt=Math.ceil(now+Math.max(delay,retry??0));
  return copy({startedAt,deadlineAt,failures,dueAt,reason:input.reason,
    exhausted:!input.retryable||failures>policy.failureRetries||now<startedAt||dueAt>=deadlineAt||previous?.exhausted===true});
}
export function responsesPollDue(policy:ResponsesObservationPolicy,polls:number,now:number,jitter:number):number {
  if(!Number.isSafeInteger(polls)||polls<0||!Number.isFinite(now)||jitter<0||jitter>1)throw new NativeProtocolError("responses_poll_invalid");
  return Math.ceil(now+Math.min(policy.pollMaximumMs,Math.max(policy.pollMinimumMs,policy.pollMinimumMs*2**Math.min(polls,20)*(0.8+0.4*jitter))));
}
function retryAfterMs(value:string|null,now:number):number|null {
  if(value===null)return null;
  if(/^\d+(\.\d+)?$/.test(value))return Number(value)*1000;
  const time=Date.parse(value);return Number.isFinite(time)?Math.max(0,time-now):null;
}

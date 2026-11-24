import type {ControllerInputDeliveryReceipt} from "@agent-anything/agent-runtime/decision";
import type {HelarcNativeTaskBinding,HelarcCommittedTaskReply} from "./HelarcNativeTask.js";
import type {HelarcNativeResultPresentation} from "./HelarcRetainedNativeInput.js";
import type {HelarcNativeWorkingSources} from "./HelarcNativeWorkingSources.js";

export interface HelarcNativePreparedTask {
  readonly format:"helarc.native-prepared-task.v1";
  readonly binding:HelarcNativeTaskBinding;
  readonly wire:{readonly body:string;readonly digest:string};
  readonly previous:HelarcCommittedTaskReply|null;
  readonly selectedInputId?:string;
  readonly resultPresentations?:readonly HelarcNativeResultPresentation[];
}
export interface HelarcNativeRunTask extends HelarcNativePreparedTask {
  readonly sourceDigest:string;
  readonly workingSources?:HelarcNativeWorkingSources;
  readonly delivery:Extract<ControllerInputDeliveryReceipt["via"],{kind:"protocol"}>["mapping"];
  readonly results:readonly {readonly callId:string;readonly position:string;readonly contentDigest:string}[];
}

import type {NativeInputManifest,ResponsesInputContinuity} from "@agent-anything/provider-integrations/native";
import type {ModelResultTextSlot} from "@agent-anything/model-interaction/input";
import type {HelarcResponsesCompactionAgreement} from "./HelarcResponsesInRequestEvidence.js";
import type {HelarcNativeWorkingSources} from "./HelarcNativeWorkingSources.js";

export interface HelarcRetainedNativeInput {
  readonly kind: "helarc_native_input";
  readonly manifest: NativeInputManifest;
  readonly wire: { readonly body: string; readonly digest: string };
  readonly prefixGroups: number;
  readonly predecessor: string | null;
  readonly continuity: ({ readonly kind: "responses" } & ResponsesInputContinuity) | { readonly kind: "explicit" };
  readonly compactionAgreement?:HelarcResponsesCompactionAgreement;
  readonly resultPresentations?:readonly HelarcNativeResultPresentation[];
  readonly workingSources?:HelarcNativeWorkingSources;
}
export interface HelarcNativeResultPresentation {
  readonly groupId:string;
  readonly position:string;
  readonly slot:ModelResultTextSlot;
  readonly representation:{readonly id:string;readonly revision:string};
}

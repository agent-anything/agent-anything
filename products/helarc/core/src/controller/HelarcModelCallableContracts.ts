import type {ModelCallableDefinition} from "@agent-anything/model-interaction";
import type {ToolRevisionRef,ToolBindingRef} from "@agent-anything/tools/identity";

export type HelarcModelCallableBinding =
  | {
      readonly kind: "tool";
      readonly callableName: string;
      readonly toolName: string;
      readonly tool: ToolRevisionRef;
      readonly binding: ToolBindingRef;
    }
  | {
      readonly kind: "control";
      readonly callableName: "update_plan";
      readonly control: "update_plan";
    }
  | {
      readonly kind: "control";
      readonly callableName: "final_result";
      readonly control: "final_result";
    };

export interface HelarcModelCallableCatalog {
  readonly revision: string;
  readonly definitionsDigest: string;
  readonly toolExposureProofId: string;
  readonly toolExposureContentRevision: string;
  readonly toolGuidanceId: string;
  readonly toolGuidanceContentDigest: string;
  readonly controlGuidanceRevision: string;
  readonly definitions: readonly ModelCallableDefinition[];
  readonly bindings: readonly HelarcModelCallableBinding[];
}


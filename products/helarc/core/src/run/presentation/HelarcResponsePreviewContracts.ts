

export interface HelarcResponsePreviewPart {
  readonly id: string;
  readonly kind: "text" | "tool_call" | "final_response" | "reasoning";
  readonly text: string;
  readonly receivedLength: number;
  readonly omittedBytes: number;
  readonly name: string | null;
  readonly modelItemId: string | null;
  readonly turnId: string | null;
  readonly groupId?:string;
  readonly nativeSource?:import("@agent-anything/model-interaction/protocol").NativeModelSourceRef;
  readonly committedRecordId: string | null;
}
export interface HelarcResponsePreview {
  readonly runId: string;
  readonly requestId: string;
  readonly controllerRequestId: string;
  readonly invocationId: string;
  readonly revision: number;
  readonly observedAt: string;
  readonly deliverySequence: number;
  readonly mode: "buffered" | "streaming";
  readonly state:
    | "receiving"
    | "received"
    | "validated"
    | "committed"
    | "interrupted"
    | "cancelled"
    | "failed"
    | "rejected";
  readonly code: string | null;
  readonly parts: readonly HelarcResponsePreviewPart[];
}
export interface HelarcResponsePreviews {
  readonly revision: number;
  readonly omittedAttempts: number;
  readonly retainedBytes: number;
  readonly attempts: readonly HelarcResponsePreview[];
}


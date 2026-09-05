import type { HelarcInstructionSettings } from "./HelarcInstructionSettings.js";

export const HELARC_PRODUCT_COMMAND_VERSION = 1 as const;
export const HELARC_PRODUCT_COMMAND_RECEIPT_LIMIT = 4_096;

export type HelarcProductCommandKind =
  | "workspace.choose"
  | "workspace.select"
  | "provider.save"
  | "instructions.save"
  | "run.start"
  | "thread.open";

export type HelarcProductRunStartTarget =
  | { readonly kind: "new_thread" }
  | {
      readonly kind: "continue_thread";
      readonly threadId: string;
    };

export interface HelarcProductCommandPayloadMap {
  readonly "instructions.save": { readonly settings: HelarcInstructionSettings };
  readonly "workspace.choose": Record<string, never>;
  readonly "workspace.select": {
    readonly profileId: string;
  };
  readonly "provider.save": {
    readonly providerKind: "openai-compatible" | "ollama";
    readonly displayName: string;
    readonly baseUrl: string;
    readonly model: string;
    readonly timeoutMs: number;
    readonly ollamaRuntime: {
      readonly contextWindowTokens: number;
      readonly maximumOutputTokens: number;
    } | null;
    readonly qualificationPolicy: "require_qualified" | "allow_experimental";
    readonly apiKeyUpdate: "keep" | "set" | "clear";
    readonly apiKey: string;
  };
  readonly "run.start": {
    readonly taskText: string;
    readonly target: HelarcProductRunStartTarget;
  };
  readonly "thread.open": {
    readonly threadId: string;
  };
}

export interface HelarcProductCommandEnvelope<
  TKind extends HelarcProductCommandKind,
> {
  readonly version: typeof HELARC_PRODUCT_COMMAND_VERSION;
  readonly commandId: string;
  readonly kind: TKind;
  readonly payload: HelarcProductCommandPayloadMap[TKind];
}

export type HelarcProductCommand = {
  [TKind in HelarcProductCommandKind]: HelarcProductCommandEnvelope<TKind>;
}[HelarcProductCommandKind];

export type HelarcProductCommandRejectionCode =
  | "helarc_product_command_invalid"
  | "helarc_product_command_version_unsupported"
  | "helarc_product_command_kind_unsupported"
  | "helarc_product_command_kind_mismatch"
  | "helarc_product_command_id_conflict"
  | "helarc_product_command_ledger_full"
  | "helarc_product_command_failed";

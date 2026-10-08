import type { HelarcInstructionSettings } from "./HelarcInstructionSettings.js";

export const HELARC_PRODUCT_COMMAND_VERSION = 1 as const;
export const HELARC_PRODUCT_COMMAND_RECEIPT_LIMIT = 4_096;

export type HelarcProductCommandKind =
  | "qualification.start"
  | "qualification.cancel"
  | "qualification.publish"
  | "project.save"
  | "project.select"
  | "project.chooseFolder"
  | "workspace.choose"
  | "workspace.select"
  | "provider.save"
  | "provider.select"
  | "provider.delete"
  | "instructions.save"
  | "inspection.save"
  | "storage.cleanup"
  | "run.start"
  | "thread.open";

export type HelarcProductRunStartTarget =
  | { readonly kind: "new_thread" }
  | {
      readonly kind: "continue_thread";
      readonly threadId: string;
    };

export interface HelarcProductCommandPayloadMap {
  readonly "provider.select": { readonly profileId: string };
  readonly "provider.delete": { readonly profileId: string; readonly expectedRevision: string };
  readonly "qualification.start": { readonly targetId: string };
  readonly "qualification.cancel": { readonly campaignId: string };
  readonly "qualification.publish": { readonly campaignId: string; readonly targetId: string; readonly reviewed: boolean };
  readonly "project.save": {
    readonly id: string | null;
    readonly expectedRevision: number | null;
    readonly name: string;
    readonly primaryProfileId: string;
    readonly additionalProfileIds: readonly string[];
  };
  readonly "project.select": { readonly projectId: string };
  readonly "project.chooseFolder": Record<string, never>;
  readonly "inspection.save": { readonly settings: import("./HelarcInspectionSettings.js").HelarcInspectionSettings };
  readonly "storage.cleanup": { readonly recordingIds: readonly string[] };
  readonly "instructions.save": { readonly settings: HelarcInstructionSettings };
  readonly "workspace.choose": Record<string, never>;
  readonly "workspace.select": {
    readonly profileId: string;
  };
  readonly "provider.save": {
    readonly profileId?: string | null;
    readonly expectedRevision?: string | null;
    readonly modelSettings?: import("./HelarcModelSelection.js").HelarcProviderModelSettings;
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
    readonly apiKeyUpdate: "keep" | "set" | "clear" | "reference";
    readonly credential?: import("./HelarcProviderCredentials.js").HelarcCredentialSelection;
    readonly apiKey: string;
  };
  readonly "run.start": {
    readonly modelSelection?: import("./HelarcModelSelection.js").HelarcModelSelection;
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

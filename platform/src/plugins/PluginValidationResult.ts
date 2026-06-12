import type { Metadata } from "../shared/types.js";

export type PluginValidationStatus = "valid" | "invalid";

export interface PluginValidationIssue {
  code: string;
  message: string;
  metadata: Metadata;
}

export interface PluginValidationResult {
  status: PluginValidationStatus;
  issues: PluginValidationIssue[];
  metadata: Metadata;
}

export class PluginRegistryError extends Error {
  readonly code: string;
  readonly issues: PluginValidationIssue[];
  readonly metadata: Metadata;

  constructor(input: {
    code: string;
    message: string;
    issues: PluginValidationIssue[];
    metadata?: Metadata;
  }) {
    super(input.message);
    this.name = "PluginRegistryError";
    this.code = input.code;
    this.issues = input.issues;
    this.metadata = input.metadata ?? {};
  }
}

export type HelarcPermissionPreset =
  | "ask_for_approval"
  | "approve_for_me"
  | "full_access";

export type HelarcPermissionPresetReviewerKind =
  | "user"
  | "auto_review"
  | null;

export interface HelarcPermissionPresetDefinition {
  readonly preset: HelarcPermissionPreset;
  readonly baseProfileId: ":workspace" | ":danger-full-access";
  readonly approvalPolicy: "on-request" | "never";
  readonly reviewerKind: HelarcPermissionPresetReviewerKind;
}

const DEFINITIONS: Readonly<Record<
  HelarcPermissionPreset,
  HelarcPermissionPresetDefinition
>> = Object.freeze({
  ask_for_approval: definition({
    preset: "ask_for_approval",
    baseProfileId: ":workspace",
    approvalPolicy: "on-request",
    reviewerKind: "user",
  }),
  approve_for_me: definition({
    preset: "approve_for_me",
    baseProfileId: ":workspace",
    approvalPolicy: "on-request",
    reviewerKind: "auto_review",
  }),
  full_access: definition({
    preset: "full_access",
    baseProfileId: ":danger-full-access",
    approvalPolicy: "never",
    reviewerKind: null,
  }),
});

export function resolveHelarcPermissionPreset(
  preset: HelarcPermissionPreset,
): HelarcPermissionPresetDefinition {
  const resolved = DEFINITIONS[preset];
  if (resolved === undefined) {
    throw new TypeError(`Unknown Helarc permission preset '${String(preset)}'.`);
  }
  return resolved;
}

function definition(
  input: HelarcPermissionPresetDefinition,
): HelarcPermissionPresetDefinition {
  return Object.freeze({ ...input });
}

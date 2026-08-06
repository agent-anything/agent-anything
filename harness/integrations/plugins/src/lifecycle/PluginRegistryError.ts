export type PluginRegistryErrorCode =
  | "plugin_not_found"
  | "plugin_duplicate_installation"
  | "plugin_package_identity_conflict"
  | "plugin_update_invalid"
  | "plugin_state_stale"
  | "plugin_state_invalid"
  | "plugin_operation_in_progress"
  | "plugin_admission_invalid"
  | "plugin_activation_unavailable"
  | "plugin_activation_rejected"
  | "plugin_activation_failed"
  | "plugin_deactivation_rejected"
  | "plugin_deactivation_failed"
  | "plugin_owner_result_invalid";

export class PluginRegistryError extends Error {
  constructor(
    readonly code: PluginRegistryErrorCode,
    message: string,
    readonly pluginId: string | null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PluginRegistryError";
  }
}

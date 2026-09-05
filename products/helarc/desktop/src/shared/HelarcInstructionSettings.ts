export interface HelarcInstructionSectionSetting {
  readonly id: string;
  readonly enabled: boolean;
  readonly content: string;
}

export interface HelarcInstructionSettings {
  readonly agent: readonly HelarcInstructionSectionSetting[];
  readonly delegated: readonly HelarcInstructionSectionSetting[];
  readonly protocol: readonly HelarcInstructionSectionSetting[];
  readonly stop: readonly HelarcInstructionSectionSetting[];
}

export interface HelarcInstructionSettingsSnapshot {
  readonly settings: HelarcInstructionSettings;
  readonly defaults: HelarcInstructionSettings;
}

export class ProviderConfigurationError extends Error {
  constructor(readonly code: string) { super(code); this.name = "ProviderConfigurationError"; }
}

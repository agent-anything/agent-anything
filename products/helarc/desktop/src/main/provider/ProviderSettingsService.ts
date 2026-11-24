import {previewProviderPolicy} from "./ProviderDraftValidation.js";
import { ProviderConfigurationError, providerToken, type ProviderConfiguration } from "../../shared/ProviderConfiguration.js";
import type { ProviderExecutionEligibility, ProviderSettingsApi, ProviderSettingsResult } from "../../shared/ProviderSettingsApi.js";
import type { ProviderConfigurationService } from "./ProviderConfigurationService.js";
import { discoverProviderModels, ProviderDiscoveryAccessError } from "./ProviderModelDiscovery.js";

/** Product selection policy is supplied by implemented Agent arrangements, never by URL compatibility. */
export function createProviderSettingsService(service: ProviderConfigurationService,
  arrangements: { eligibility(configuration: ProviderConfiguration): ProviderExecutionEligibility },
  fetchImpl: typeof fetch = globalThis.fetch, changed?: () => Promise<void>): ProviderSettingsApi {
  async function result<T>(work: () => Promise<T>, mutation = false): Promise<ProviderSettingsResult<T>> {
    try { return { ok: true, value: await work() }; }
    catch (error) {
      if (error instanceof ProviderDiscoveryAccessError) return { ok: false, code: error.code, discoveryRejection: error.rejection };
      return { ok: false, code: error instanceof ProviderConfigurationError ? error.code : "provider_settings_failed" };
    }
    finally { if (mutation) await changed?.().catch(() => {}); }
  }
  async function config(input: { id: string; revision: string }) {
    providerToken(input.id); providerToken(input.revision);
    const saved = await service.get(input.id);
    if (!saved || saved.archived || saved.revision !== input.revision) throw new ProviderConfigurationError("provider_configuration_conflict");
    return saved;
  }
  return {
    list: () => result(() => service.list()), save: input => result(() => service.save(input), true), receipt: id => result(() => service.receipt(providerToken(id))),
    previewPolicy: input => result(async () => previewProviderPolicy(input)),
    credentialSettings: id => result(() => service.credentialSettings(id)),
    discover: input => result(async () => { await config(input); return discoverProviderModels(service, input.id, input.revision, fetchImpl); }),
    eligibility: input => result(async () => {
      providerToken(input.id); providerToken(input.revision);
      const current = await service.get(input.id);
      const selected = await service.defaultConfiguration();
      const saved = current?.revision === input.revision ? current : selected?.id === input.id && selected.revision === input.revision ? selected : null;
      if (!saved || saved.archived) throw new ProviderConfigurationError("provider_configuration_conflict");
      return arrangements.eligibility(saved);
    }),
    activate: input => result(async () => {
      await config(input);
      const saved = await service.activate(input.id, input.revision, candidate => {
        const eligible = arrangements.eligibility(candidate);
        if (!eligible.available) throw new ProviderConfigurationError(eligible.reason ?? "provider_arrangement_unavailable");
      });
      return saved;
    }, true),
    archive: input => result(async () => { await service.archive(providerToken(input.id), providerToken(input.revision)); return null; }, true),
    dependencies: id => result(() => service.dependencies(providerToken(id))),
    revoke: input => result(async () => {
      if (input.confirmed !== true) throw new ProviderConfigurationError("provider_confirmation_required");
      await service.revoke(providerToken(input.bindingId), input.revision); return null;
    }, true),
    repair: input => result(async () => {
      await service.repair(providerToken(input.bindingId), input.revision, providerToken(input.replacementBindingId), input.confirmedSameScope === true); return null;
    }, true),
    destroyCredential: input => result(async () => {
      if (input.confirmed !== true) throw new ProviderConfigurationError("provider_confirmation_required");
      await service.destroyCredential(providerToken(input.bindingId), input.revision); return null;
    }, true),
  };
}

import { test, expect } from "@playwright/test";

test("named profiles, metadata-backed thinking and credentials stay independent", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    const profiles: any[] = [{
      id: "local", revision: "1", providerKind: "ollama", displayName: "Local Ollama",
      baseUrl: "http://localhost:11435/", model: "gemma4:e4b", timeoutMs: 300000000,
      credentialStatus: "empty_allowed", qualificationPolicy: "allow_experimental", isActive: true,
      ollamaRuntime: { contextWindowTokens: 163840, maximumOutputTokens: 2048 },
      modelSettings: { service: "ollama", thinking: { mode: "default" }, maximumOutputTokens: 4096 },
    }];
    const snapshot: any = {
      projects: [], selectedProjectId: null, status: "idle", workspace: null, workspaceProfiles: [],
      acceptedTask: null, activeThread: null, threadSummaries: [], run: null, error: null,
      provider: { configured: true, nativeToolInteraction: { supported: true }, profiles, error: null, activeProfile: profiles[0] },
    };
    const saves: any[] = [];
    (window as any).providerSettingsSaves = saves;
    const receipt = () => ({ status: "handled", result: structuredClone(snapshot) });
    (window as any).helarc = {
      getSnapshot: async () => structuredClone(snapshot), subscribeSnapshot: () => () => {},
      getProviderCredentialSettings: async ({ profileId }: any) => ({ windowsAvailable: true,
        selection: profiles.find(p => p.id === profileId)?.credential ?? { source: "safe-storage" } }),
      getQualification: async () => ({ available: false, error: null, campaigns: [], activeCampaignId: null,
        targetId: null, model: snapshot.provider.activeProfile.model, disposition: "experimental", scopes: [],
        protocol: { revision: "fixture", totalTrials: 21, maximumRequests: 63, requestTimeoutMs: 120000, limitations: [] } }),
      discoverModels: async (query: any) => ({ ok: true, profileId: query.profileId, profileRevision: query.profileRevision,
        catalog: { observedAt: new Date().toISOString(), source: "fixture", declarationRevision: null,
          models: [{ id: query.model || "deepseek-flash", name: query.model || "deepseek-flash", artifact: null, contextWindowTokens: null, maximumOutputTokens: null,
            thinking: query.profileId === "local"
              ? { status: "known", source: "endpoint", values: [false, true], defaultValue: true }
              : { status: "known", source: "endpoint", values: [false, true, "low", "high", "max"], defaultValue: "high" } }] } }),
      selectProvider: async ({ profileId }: any) => { snapshot.provider.activeProfile = profiles.find(p => p.id === profileId); return receipt(); },
      deleteProvider: async ({ profileId }: any) => { profiles.splice(profiles.findIndex(p => p.id === profileId), 1); snapshot.provider.activeProfile = profiles[0]; return receipt(); },
      saveProviderConfig: async (input: any) => {
        saves.push(input);
        const previous = profiles.find(p => p.id === input.profileId);
        const profile = { id: input.profileId ?? "remote", revision: String(Number(previous?.revision ?? 0) + 1),
          providerKind: input.providerKind, displayName: input.displayName, baseUrl: new URL(input.baseUrl).href,
          model: input.model, timeoutMs: input.timeoutMs, ollamaRuntime: input.ollamaRuntime, modelSettings: input.modelSettings,
          qualificationPolicy: input.qualificationPolicy, credentialStatus: input.apiKeyUpdate === "clear" ? "empty_allowed" : "present" };
        (profile as any).credential = input.credential;
        if (previous) profiles.splice(profiles.indexOf(previous), 1, profile); else profiles.push(profile);
        snapshot.provider.activeProfile = profile;
        snapshot.provider.configured = !!profile.model;
        snapshot.provider.error = profile.model ? null : { code: "provider_config_missing", message: "Select a model before starting work or verification." };
        return receipt();
      },
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Open settings", exact: true }).click();
  const form = page.getByRole("form", { name: "Provider settings" });
  const thinking = form.getByLabel("Thinking", { exact: true });
  await expect(thinking.locator("option")).toHaveCount(3);
  await thinking.selectOption("disabled");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).providerSettingsSaves.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).providerSettingsSaves[0])).toMatchObject({
    profileId: "local", expectedRevision: "1", modelSettings: { service: "ollama", thinking: { mode: "disabled" } }, apiKeyUpdate: "clear",
  });
  await form.getByRole("button", { name: "Add Provider" }).click();
  await form.getByLabel("Service", { exact: true }).selectOption("deepseek");
  await form.getByLabel("Name", { exact: true }).fill("DeepSeek");
  await expect(form.getByLabel("Model", { exact: true })).toHaveValue("");
  await expect(thinking).toBeDisabled();
  await form.getByLabel("API key", { exact: true }).fill("fixture-key");
  await expect(thinking.locator("option")).toHaveCount(1);
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(form.getByLabel("API key", { exact: true })).toHaveValue("");
  await expect(form.getByLabel("API key", { exact: true })).toHaveAttribute("placeholder", "Stored key is present");
  await expect(form.locator('#provider-models option[value="deepseek-flash"]')).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).providerSettingsSaves[1])).toMatchObject({ model: "", apiKeyUpdate: "set" });
  await form.getByLabel("Model", { exact: true }).fill("deepseek-flash");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).providerSettingsSaves.length)).toBe(3);
  await expect(thinking.locator("option")).toHaveCount(6);
  await thinking.selectOption("effort:max");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).providerSettingsSaves.length)).toBe(4);
  expect(await page.evaluate(() => (window as any).providerSettingsSaves[3])).toMatchObject({
    profileId: "remote", modelSettings: { service: "deepseek", thinking: { mode: "enabled", effort: "max" } }, apiKeyUpdate: "keep", apiKey: "",
  });
  await form.getByLabel("Saved configuration").selectOption("local");
  await expect(form.getByLabel("Model", { exact: true })).toHaveValue("gemma4:e4b");
  await expect(thinking).toHaveValue("disabled");
  await form.getByLabel("Saved configuration").selectOption("remote");
  await expect(thinking).toHaveValue("effort:max");
  await expect(thinking.locator("option")).toHaveCount(6);
  await form.getByLabel("Credential storage", { exact: true }).selectOption("windows-managed");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).providerSettingsSaves.at(-1).credential.source)).toBe("windows-managed");
  await expect(form.getByLabel("Credential storage", { exact: true })).toHaveValue("windows-managed");
  await form.getByLabel("Credential storage", { exact: true }).selectOption("windows-reference");
  await expect(form.getByLabel("API key", { exact: true })).toHaveCount(0);
  await form.getByLabel("Credential target", { exact: true }).fill("Example/DeepSeek");
  await form.getByLabel("Credential encoding", { exact: true }).selectOption("utf8");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).providerSettingsSaves.at(-1).apiKeyUpdate)).toBe("reference");
  expect(await page.evaluate(() => (window as any).providerSettingsSaves.at(-1))).toMatchObject({ apiKey: "", credential: { source: "windows-reference", target: "Example/DeepSeek", encoding: "utf8" } });
  await expect(form.getByLabel("Credential target", { exact: true })).toHaveValue("Example/DeepSeek");
  await page.screenshot({ path: testInfo.outputPath("provider-settings.png"), fullPage: true });
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await page.locator(".wb-context > summary").click();
  await expect(page.getByLabel("Next task Provider")).toHaveValue("remote");
  await expect(page.getByLabel("Next task model")).toHaveValue("deepseek-flash");
  await page.getByLabel("Next task Provider").selectOption("local");
  await expect(page.getByLabel("Next task model")).toHaveValue("gemma4:e4b");
  await page.getByRole("button", { name: "Open settings", exact: true }).click();
  await expect(form.getByLabel("Saved configuration")).toHaveValue("remote");
  page.on("dialog", dialog => dialog.accept());
  await form.getByRole("button", { name: "Delete Provider" }).click();
  await expect(form.getByLabel("Model", { exact: true })).toHaveValue("gemma4:e4b");
  await expect(form.getByLabel("Saved configuration").locator("option")).toHaveCount(2);
  expect(errors).toEqual([]);
});

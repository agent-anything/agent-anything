import { test, expect } from "@playwright/test";

for (const initialKind of ["openai-compatible", "ollama"] as const) {
  test(`Provider drafts switch independently from saved ${initialKind} settings`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(kind => {
      const profile = kind === "openai-compatible"
        ? { providerKind: kind, displayName: "DeepSeek", baseUrl: "https://api.deepseek.com/",
            model: "deepseek-flash", ollamaRuntime: null, credentialStatus: "present" }
        : { providerKind: kind, displayName: "Local Ollama", baseUrl: "http://localhost:11435/",
            model: "gemma4:e4b", ollamaRuntime: { contextWindowTokens: 163840, maximumOutputTokens: 2048 },
            credentialStatus: "empty_allowed" };
      const snapshot: any = {
        projects: [], selectedProjectId: null, status: "idle", workspace: null, workspaceProfiles: [],
        acceptedTask: null, activeThread: null, threadSummaries: [], run: null, error: null,
        provider: { configured: true, nativeToolInteraction: { supported: true }, profiles: [], error: null,
          activeProfile: { id: "desktop-provider", timeoutMs: 300000000,
            qualificationPolicy: "allow_experimental", ...profile } },
      };
      const saves: any[] = [];
      (window as any).providerSettingsSaves = saves;
      (window as any).helarc = {
        getSnapshot: async () => structuredClone(snapshot), subscribeSnapshot: () => () => {},
        getQualification: async () => ({ available: false, error: null, campaigns: [], activeCampaignId: null,
          targetId: null, model: profile.model, disposition: "experimental", scopes: [],
          protocol: { revision: "helarc.native-call-baseline.v2", totalTrials: 21, maximumRequests: 63,
            requestTimeoutMs: 120000, limitations: [] } }),
        saveProviderConfig: async (input: any) => {
          saves.push(input);
          snapshot.provider.activeProfile = {
            ...snapshot.provider.activeProfile,
            providerKind: input.providerKind, displayName: input.displayName,
            baseUrl: new URL(input.baseUrl).href, model: input.model,
            timeoutMs: input.timeoutMs, ollamaRuntime: input.ollamaRuntime,
            qualificationPolicy: input.qualificationPolicy,
            credentialStatus: input.apiKeyUpdate === "clear" ? "empty_allowed" : "present",
          };
          return { status: "handled", result: structuredClone(snapshot) };
        },
      };
    }, initialKind);
    await page.goto("/");
    const open = () => page.getByRole("button", { name: "Open settings", exact: true }).click();
    await open();
    const form = page.getByRole("form", { name: "Provider settings" });
    const type = form.getByRole("combobox", { name: "Type", exact: true });
    const baseUrl = form.getByLabel("Base URL", { exact: true });
    const model = form.getByLabel("Model", { exact: true });
    const key = form.getByLabel("API key", { exact: true });
    if (initialKind === "openai-compatible") {
      await type.selectOption("ollama");
      await expect(baseUrl).toHaveValue("http://localhost:11435");
      await expect(model).toHaveValue("gemma4:e4b");
      await expect(form.getByLabel("Context window")).toHaveValue("163840");
      await expect(key).not.toHaveAttribute("placeholder", "Stored key is present");
      await model.fill("local-custom-model");
      await type.selectOption("openai-compatible");
      await expect(baseUrl).toHaveValue("https://api.deepseek.com/");
      await expect(model).toHaveValue("deepseek-flash");
      await expect(key).toHaveAttribute("placeholder", "Stored key is present");
      await expect(form.getByLabel("Context window")).toHaveCount(0);
      await type.selectOption("ollama");
      await expect(model).toHaveValue("local-custom-model");
      expect(await page.evaluate(() => (window as any).providerSettingsSaves)).toEqual([]);
      await form.getByRole("button", { name: "Save", exact: true }).click();
      await expect.poll(() => page.evaluate(() => (window as any).providerSettingsSaves.length)).toBe(1);
      expect(await page.evaluate(() => (window as any).providerSettingsSaves[0])).toMatchObject({
        providerKind: "ollama", baseUrl: "http://localhost:11435", model: "local-custom-model",
        apiKeyUpdate: "clear", apiKey: "", ollamaRuntime: { contextWindowTokens: 163840, maximumOutputTokens: 2048 },
      });
      await page.getByRole("button", { name: "Close settings" }).click();
      await open();
      await expect(type).toHaveValue("ollama");
      await expect(baseUrl).toHaveValue("http://localhost:11435/");
      await expect(model).toHaveValue("local-custom-model");
    } else {
      await type.selectOption("openai-compatible");
      await expect(baseUrl).toHaveValue("");
      await expect(model).toHaveValue("");
      await baseUrl.fill("https://api.deepseek.com/");
      await model.fill("deepseek-flash");
      await key.fill("test-only-key");
      await type.selectOption("ollama");
      await expect(model).toHaveValue("gemma4:e4b");
      await expect(key).toHaveValue("");
      await type.selectOption("openai-compatible");
      await expect(model).toHaveValue("deepseek-flash");
      await expect(key).toHaveValue("test-only-key");
      await form.getByRole("button", { name: "Save", exact: true }).click();
      await expect(key).toHaveValue("");
      await expect(key).toHaveAttribute("placeholder", "Stored key is present");
      expect(await page.evaluate(() => (window as any).providerSettingsSaves[0])).toMatchObject({
        providerKind: "openai-compatible", apiKeyUpdate: "set", apiKey: "test-only-key", ollamaRuntime: null,
      });
      await model.fill("another-model");
      await form.getByRole("button", { name: "Save", exact: true }).click();
      await expect.poll(() => page.evaluate(() => (window as any).providerSettingsSaves.length)).toBe(2);
      expect(await page.evaluate(() => (window as any).providerSettingsSaves[1].apiKeyUpdate)).toBe("keep");
      await key.fill("another-test-key");
      await baseUrl.fill("https://other-provider.invalid/v1");
      await expect(key).toHaveValue("");
      await expect(key).not.toHaveAttribute("placeholder", "Stored key is present");
      await form.getByRole("button", { name: "Save", exact: true }).click();
      await expect.poll(() => page.evaluate(() => (window as any).providerSettingsSaves.length)).toBe(3);
      expect(await page.evaluate(() => (window as any).providerSettingsSaves[2].apiKeyUpdate)).toBe("clear");
    }
    expect(errors).toEqual([]);
  });
}

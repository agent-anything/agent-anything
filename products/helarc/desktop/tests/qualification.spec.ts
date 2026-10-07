import { test, expect } from "@playwright/test";

test("Settings verification, cancel, retained evidence and explicit publication", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    const snapshot = {
      projects: [], selectedProjectId: null, status: "idle", workspace: null, workspaceProfiles: [],
      acceptedTask: null, activeThread: null, threadSummaries: [], run: null, error: null,
      provider: { configured: true, nativeToolInteraction: { supported: true }, profiles: [], error: null,
        activeProfile: { id: "provider", providerKind: "ollama", displayName: "Local Ollama", baseUrl: "http://localhost:11435",
          model: "test-model", timeoutMs: 300000000, credentialStatus: "empty_allowed", qualificationPolicy: "require_qualified",
          ollamaRuntime: { contextWindowTokens: 163840, maximumOutputTokens: 2048 } } },
    };
    const scopeNames = ["agent_loop", "workspace_observation", "workspace_mutation", "process_execution", "user_interaction", "delegation"];
    const qualification: any = { available: true, error: null, targetId: "target", model: "test-model", disposition: "blocked",
      scopes: scopeNames.map(scope => ({ scope, applicability: "missing", outcome: null })), activeCampaignId: null, campaigns: [],
      protocol: { revision: "helarc.native-call-baseline.v2", totalTrials: 21, maximumRequests: 63, requestTimeoutMs: 120000,
        limitations: ["Fixture results only; physical Tools are not executed.", "Model alias identity is not immutable."] } };
    const handled = () => ({ status: "handled", result: { ok: true } });
    (window as any).qualificationFixture = {
      complete(outcome = "qualified") {
        qualification.activeCampaignId = null;
        Object.assign(qualification.campaigns[0], { status: "completed", completedTrials: 21, currentCase: null,
          results: scopeNames.map((scope, index) => ({ scope, outcome: index === 0 ? outcome : "qualified",
            passed: index === 0 && outcome !== "qualified" ? 2 : 3, total: 3, required: 3 })),
          trials: outcome === "qualified"
            ? [{ id: "trial", title: "Explicit final response", repetition: 1, outcome: "passed", reason: "observed_expected_behavior",
              stage: "final_response", failureCategory: null, resultDelivery: "not_applicable" }]
            : [{ id: "trial", title: "Respect a denied write", repetition: 1, outcome: outcome === "inconclusive" ? "inconclusive" : "failed",
              reason: outcome === "inconclusive" ? "request_timeout" : "incorrect_tool_arguments", stage: "operation_request",
              failureCategory: outcome === "inconclusive" ? "infrastructure" : "case_requirement", resultDelivery: "not_submitted" }] });
      },
    };
    (window as any).helarc = {
      getSnapshot: async () => snapshot, subscribeSnapshot: () => () => {},
      getQualification: async () => structuredClone(qualification),
      startQualification: async () => {
        const id = `campaign-${qualification.campaigns.length}`;
        qualification.activeCampaignId = id;
        qualification.campaigns.unshift({ id, model: "test-model", startedAt: new Date().toISOString(), status: "running",
          currentCase: "Read and consume result (1/3)", completedTrials: 0, totalTrials: 21, currentTarget: true,
          publishedAt: null, results: [], trials: [] });
        return handled();
      },
      cancelQualification: async () => { qualification.activeCampaignId = null; qualification.campaigns[0].status = "cancelled"; return handled(); },
      publishQualification: async () => {
        qualification.campaigns[0].publishedAt = new Date().toISOString(); qualification.disposition = "qualified";
        qualification.scopes = scopeNames.map(scope => ({ scope, applicability: "applicable", outcome: "qualified" }));
        return handled();
      },
      readQualificationEvidence: async () => ({ ok: true, text: JSON.stringify({ outcome: "passed", messages: ["user", "assistant"] }, null, 2) }),
      saveProviderConfig: async () => ({ status: "handled", result: snapshot }),
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Open settings", exact: true }).click();
  const section = page.getByRole("region", { name: "Model qualification" });
  await expect(section.getByRole("button", { name: "Run verification" })).toBeEnabled();
  await page.getByLabel("Model", { exact: true }).fill("unsaved-model");
  await expect(section.getByRole("button", { name: "Run verification" })).toBeDisabled();
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.getByRole("button", { name: "Open settings", exact: true }).click();
  await section.getByRole("button", { name: "Run verification" }).click();
  await expect(section.getByText("Read and consume result (1/3)")).toBeVisible();
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.getByRole("button", { name: "Open settings", exact: true }).click();
  await section.getByRole("button", { name: "Cancel verification" }).click();
  for (const outcome of ["not_qualified", "inconclusive"]) {
    await section.getByRole("button", { name: "Run verification" }).click();
    await page.evaluate(value => (window as any).qualificationFixture.complete(value), outcome);
    const campaign = section.locator("details.qualification-campaign").first();
    await expect(campaign.locator("summary")).toContainText("Completed");
    if (!(await campaign.evaluate(el => (el as HTMLDetailsElement).open))) await campaign.locator("summary").click();
    await expect(campaign.getByText("Verification did not pass.", { exact: false })).toBeVisible();
    await expect(campaign.getByRole("button", { name: "Publish reviewed results" })).toHaveCount(0);
    await expect(campaign.getByRole("button", { name: "Configuration evidence" })).toBeVisible();
    await expect(campaign.getByText("Tool result not submitted; result handling was not tested.", { exact: false })).toBeVisible();
    await expect(campaign.getByText("Operation request", { exact: false })).toBeVisible();
  }
  await section.getByRole("button", { name: "Run verification" }).click();
  await page.evaluate(() => (window as any).qualificationFixture.complete());
  const campaign = section.locator("details.qualification-campaign").first();
  await expect(campaign.locator("summary")).toContainText("Completed");
  if (!(await campaign.evaluate(el => (el as HTMLDetailsElement).open))) await campaign.locator("summary").click();
  await campaign.getByRole("button", { name: "Explicit final response" }).click();
  await expect(section.locator("pre")).toContainText('"outcome": "passed"');
  await expect(campaign.getByRole("button", { name: "Publish reviewed results" })).toBeDisabled();
  await campaign.getByRole("checkbox").check();
  await campaign.getByRole("button", { name: "Publish reviewed results" }).click();
  await expect(campaign.locator("summary")).toContainText("Published");
  await page.screenshot({ path: testInfo.outputPath("qualification-settings.png"), fullPage: true });
  await page.setViewportSize({ width: 760, height: 900 });
  await expect(section.getByRole("button", { name: "Run verification" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

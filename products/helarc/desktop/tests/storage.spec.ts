import { test, expect } from "@playwright/test";

test("Storage shows usage, protects open recordings and confirms selective cleanup", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    const application = { projects: [], selectedProjectId: null, status: "idle", workspace: null, workspaceProfiles: [],
      acceptedTask: null, activeThread: null, threadSummaries: [], run: null, error: null,
      provider: { configured: false, nativeToolInteraction: { supported: true }, profiles: [], error: null, activeProfile: null } };
    const storage = {
      measuredAt: "2026-10-08T11:00:00.000Z", issues: [],
      categories: [
        { id: "conversations", name: "Conversations and transcripts", bytes: 27 * 1024 * 1024, files: 20 },
        { id: "command-output", name: "Command output", bytes: 410000, files: 40 },
        { id: "qualification", name: "Model qualification", bytes: 140000, files: 1 },
        { id: "cache", name: "Application cache", bytes: 4200000, files: 8 },
        { id: "configuration", name: "Configuration and other app data", bytes: 24000, files: 10 },
      ],
      inspection: { bytes: 104857600, sourceLimitBytes: 2047 * 1024 * 1024, datasetLimitBytes: 511 * 1024 * 1024,
        health: { available: true, queued: 0, dropped: 0, rejected: 0, code: null },
        recordings: [
          { id: "active-recording", createdAt: "2026-10-08T11:00:00.000Z", bytes: 10485760, status: "open", captureFailure: null },
          { id: "closed-recording", createdAt: "2026-10-07T09:30:00.000Z", bytes: 52428800, status: "closed", captureFailure: null },
          { id: "failed-recording", createdAt: "2026-10-06T09:30:00.000Z", bytes: 41943040, status: "closed", captureFailure: "inspection_storage_budget_exhausted" },
        ],
      },
    };
    const calls: string[][] = [];
    (window as any).cleanupCalls = calls;
    (window as any).helarc = {
      getSnapshot: async () => structuredClone(application), subscribeSnapshot: () => () => {},
      getQualification: async () => ({ available: false, error: null, campaigns: [], scopes: [] }),
      getStorage: async () => structuredClone(storage),
      cleanupStorage: async ({ recordingIds }: { recordingIds: string[] }) => {
        calls.push(recordingIds);
        storage.inspection.bytes -= storage.inspection.recordings.filter(r => recordingIds.includes(r.id)).reduce((sum, r) => sum + r.bytes, 0);
        storage.inspection.recordings = storage.inspection.recordings.filter(r => !recordingIds.includes(r.id));
        return { status: "handled", result: { recordings: recordingIds.map(id => ({ id, status: "removed" })) } };
      },
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Open settings", exact: true }).click();
  await page.getByRole("tab", { name: "Storage", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Storage", exact: true })).toBeVisible();
  await expect(page.locator(".storage-heading").first()).toHaveCSS("display", "flex");
  await expect(page.getByLabel("Select recording active-recording", { exact: true })).toBeDisabled();
  await page.getByLabel("Select recording closed-recording", { exact: true }).check();
  await page.getByRole("button", { name: "Delete selected (1)", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  expect(await page.evaluate(() => (window as any).cleanupCalls)).toEqual([]);
  await page.screenshot({ path: info.outputPath("storage-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "Delete recordings", exact: true }).click();
  await expect(page.getByText("1 removed. 0 retained.", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).cleanupCalls)).toEqual([["closed-recording"]]);
  await expect(page.getByLabel("Select recording closed-recording", { exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 960, height: 720 });
  await page.getByLabel("Select recording failed-recording", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("storage-compact.png"), fullPage: true });
  expect(await page.locator(".storage-panel").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(errors).toEqual([]);
});

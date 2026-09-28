import { test, expect, _electron } from "@playwright/test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("configured local model streams through Electron and retains one explicit final reply", async ({}, info) => {
  test.skip(
    !process.env.HELARC_LIVE_OLLAMA_ENDPOINT,
    "Opt-in local model acceptance",
  );
  test.setTimeout(300000);
  const userData = await mkdtemp(join(tmpdir(), "helarc-local-model-"));
  const env = {
    ...process.env,
    HELARC_SMOKE_USER_DATA: userData,
    HELARC_SMOKE_ENDPOINT: process.env.HELARC_LIVE_OLLAMA_ENDPOINT,
    HELARC_SMOKE_PROVIDER_KIND: "ollama",
    HELARC_SMOKE_MODEL: process.env.HELARC_LIVE_OLLAMA_MODEL ?? "gemma4:e4b",
    HELARC_SMOKE_TIMEOUT_MS: "240000",
    HELARC_SMOKE_TRANSPORT_DIAGNOSTICS: "1",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    args: [fileURLToPath(new URL("./electron-smoke.mjs", import.meta.url))],
    env,
  });
  try {
    const page = await app.firstWindow();
    await page.evaluate(() => {
      const evidence = {
        frames: 0,
        textFrames: 0,
        receivingTextFrames: 0,
        firstTextAt: 0,
        lastTextAt: 0,
        previewSeen: false,
        previewAt: 0,
        subscription: "pending",
        terminalAt: 0,
      };
      (window as any).streamEvidence = evidence;
      new MutationObserver(() => {
        evidence.previewSeen ||= [
          ...document.querySelectorAll(".wb-preview .wb-muted"),
        ].some((label) => label.textContent === "Responding");
        if (evidence.previewSeen) evidence.previewAt ||= Date.now();
      }).observe(document.body, { childList: true, subtree: true });
      let subscribed = false;
      window.helarc.subscribeSnapshot((snapshot) => {
        if (snapshot.run?.display.terminal) evidence.terminalAt = Date.now();
        if (
          subscribed ||
          !snapshot.run ||
          !snapshot.activeThread ||
          snapshot.run.display.terminal
        )
          return;
        subscribed = true;
        void window.helarc
          .subscribeResponseProgress(
            {
              threadId: snapshot.activeThread.id,
              productRunId: snapshot.run.productRunId,
            },
            (frame) => {
              evidence.frames++;
              if (
                frame.attempt.parts.some((p) => (p.kind === "text" || p.kind === "final_response") && p.text)
              ) {
                evidence.textFrames++;
                if (frame.attempt.state === "receiving")
                  evidence.receivingTextFrames++;
                evidence.firstTextAt ||= Date.now();
                evidence.lastTextAt = Date.now();
              }
            },
          )
          .then((result) => {
            evidence.subscription = result.status;
          });
      });
    });
    await page
      .locator("#task-input")
      .fill(
        "Briefly explain the difference between a byte and a character. Do not read or change files.",
      );
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const evidence = (window as any).streamEvidence;
            return evidence.previewSeen || evidence.terminalAt > 0;
          }),
        { timeout: 240000 },
      )
      .toBe(true);
    const streamEvidence = await page.evaluate(
      () => (window as any).streamEvidence,
    );
    console.log("Local stream evidence:", JSON.stringify(streamEvidence));
    console.log(
      "Local transport evidence:",
      JSON.stringify(
        await app.evaluate(() => (globalThis as any).smokeTransportStats),
      ),
    );
    await info.attach("stream-timing", {
      body: JSON.stringify(streamEvidence, null, 2),
      contentType: "application/json",
    });
    expect(streamEvidence.previewSeen, JSON.stringify(streamEvidence)).toBe(
      true,
    );
    expect(streamEvidence.receivingTextFrames).toBeGreaterThan(0);
    if (streamEvidence.terminalAt > 0)
      expect(streamEvidence.previewAt).toBeLessThan(streamEvidence.terminalAt);
    await page.screenshot({
      path: info.outputPath("local-model-streaming.png"),
    });
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.helarc.getSnapshot())).run?.display
            .status,
        { timeout: 240000 },
      )
      .toBe("completed");
    await expect(page.locator(".wb-preview")).toHaveCount(0);
    const transport = await app.evaluate(
      () => (globalThis as any).smokeTransportStats,
    );
    expect(transport.length).toBeGreaterThan(0);
    expect(transport.every((request: any) => request.stream && request.systemMessages === 0)).toBe(true);
    const replies = page.locator(".wb-message-assistant");
    const replyCount = await replies.count();
    expect(replyCount).toBeGreaterThan(0);
    const replyBody = replies.locator(":scope > .wb-markdown");
    const reply = (await replyBody.last().textContent()) ?? "";
    expect(reply.length).toBeGreaterThan(100);
    await expect
      .poll(async () => {
        const data = JSON.parse(
          await readFile(join(userData, "threads.json"), "utf8"),
        );
        return data.aggregates[0]?.record.runs[0]?.terminal?.host.status;
      })
      .toBe("completed");
    const data = JSON.parse(await readFile(join(userData, "threads.json"), "utf8"));
    const recorded = data.aggregates[0].record.runs[0].lastProjection.product.presentation.records;
    const finals = recorded.filter((record: any) => record.content.kind === "final_response" && record.content.disposition === "completed");
    expect(finals).toHaveLength(1);
    expect(finals[0].content.text).toBeTruthy();
    console.log("Local final-result evidence:", JSON.stringify({requests: transport.length, callId: finals[0].content.callId, characters: finals[0].content.text.length}));
    await page.reload();
    await expect(replies).toHaveCount(replyCount);
    await expect(replyBody.last()).toHaveText(reply);
    await page.screenshot({
      path: info.outputPath("local-model-completed.png"),
    });
    await info.attach("local-model-evidence", {
      body: JSON.stringify(
        {
          endpoint: env.HELARC_SMOKE_ENDPOINT,
          model: env.HELARC_SMOKE_MODEL,
          userData,
          previewBeforeTerminal: true,
          finalReplyCharacters: reply.length,
          retainedFinalReplyCount: finals.length,
          retainedAssistantEntryCount: replyCount,
          transport,
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
  } finally {
    await app.close();
  }
});

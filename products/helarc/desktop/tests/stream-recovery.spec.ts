import { test, expect, _electron } from "@playwright/test";
import { access, mkdtemp } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const sse = (delta: unknown, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: "response", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

for (const mode of ["retry", "cancel"] as const) {
  test(`actual ${mode} keeps partial responses observational`, async () => {
    const requests: any[] = [];
    let response: ServerResponse | undefined;
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      response = res;
      const writeName = body.tools.find((t: any) =>
        /^Write(?:_|$)/.test(t.function.name),
      )?.function.name;
      if (!writeName) {
        res.writeHead(500);
        res.end();
        return;
      }
      if (mode === "retry") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(
          sse({
            role: "assistant",
            content:
              requests.length === 1
                ? "Interrupted preview only."
                : "Recovered response.",
          }),
        );
        if (requests.length === 1)
          res.write(
            sse({
              tool_calls: [
                {
                  index: 0,
                  id: "unfinished-call",
                  type: "function",
                  function: {
                    name: writeName,
                    arguments:
                      '{"file_path":"never-written.txt","content":"unfinished',
                  },
                },
              ],
            }),
          );
      } else {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.write(
          JSON.stringify({
            message: {
              role: "assistant",
              content: "Unfinished response.",
              tool_calls: [
                {
                  function: {
                    name: writeName,
                    arguments: {
                      file_path: "never-written.txt",
                      content: "not committed",
                    },
                  },
                },
              ],
            },
            done: false,
          }) + "\n",
        );
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as { port: number };
    const userData = await mkdtemp(join(tmpdir(), "helarc-stream-recovery-"));
    const env = {
      ...process.env,
      HELARC_SMOKE_USER_DATA: userData,
      HELARC_SMOKE_PROVIDER_KIND:
        mode === "retry" ? "openai-compatible" : "ollama",
      HELARC_SMOKE_ENDPOINT: `http://127.0.0.1:${address.port}${mode === "retry" ? "/v1" : ""}`,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
    try {
      app = await _electron.launch({
        args: [fileURLToPath(new URL("./electron-smoke.mjs", import.meta.url))],
        env,
      });
      const page = await app.firstWindow();
      await page.locator("#task-input").fill("Reply with the result.");
      await page
        .getByRole("button", { name: "Send message", exact: true })
        .click();
      await expect(page.locator(".wb-preview")).toContainText(
        mode === "retry" ? "Interrupted preview only." : "Unfinished response.",
      );
      expect(requests).toHaveLength(1);
      const scope = await page.evaluate(async () => {
        const s = await window.helarc.getSnapshot();
        return {
          threadId: s.activeThread!.id,
          productRunId: s.run!.productRunId,
          runId: s.run!.harnessRunId,
        };
      });
      const before = await page.evaluate(
        (s) => window.helarc.readCurrentWork(s),
        scope,
      );
      expect(before).toMatchObject({
        status: "page",
        activeCalls: [],
        commands: [],
        attention: [],
      });
      await expect(
        access(join(userData, "workspace", "never-written.txt")),
      ).rejects.toThrow();

      if (mode === "retry") {
        response!.end();
        await expect.poll(() => requests.length, { timeout: 10000 }).toBe(2);
        expect(JSON.stringify(requests[1].messages)).not.toContain(
          "Interrupted preview only.",
        );
        expect(JSON.stringify(requests[1].messages)).not.toContain(
          "unfinished-call",
        );
        await expect(
          page
            .locator(".wb-preview")
            .filter({ hasText: "Recovered response." }),
        ).toBeVisible();
        response!.end(sse({}, "stop") + "data: [DONE]\n\n");
        await expect
          .poll(
            async () =>
              (await page.evaluate(() => window.helarc.getSnapshot())).run
                ?.display.status,
          )
          .toBe("completed");
        await expect(
          page
            .locator(".wb-message-assistant")
            .getByText("Recovered response.", { exact: true }),
        ).toHaveCount(1);
        const previews = await page.evaluate(
          (s) =>
            window.helarc.readResponsePreview({
              ...s,
              invocationId: null,
              cursor: null,
            }),
          scope,
        );
        expect(previews.status).toBe("page");
        if (previews.status === "page") {
          expect(previews.attempts.map((a) => a.state)).toEqual([
            "interrupted",
            "committed",
          ]);
          expect(
            new Set(previews.attempts.map((a) => a.invocationId)).size,
          ).toBe(2);
        }
        const snapshot = await page.evaluate(() => window.helarc.getSnapshot());
        expect(
          snapshot.activeThread?.artifacts.some(
            (a) => a.kind === "error-report",
          ),
        ).toBe(false);
        expect(requests).toHaveLength(2);
      } else {
        await page
          .getByRole("button", { name: "Stop work", exact: true })
          .click();
        await expect
          .poll(
            async () =>
              (await page.evaluate(() => window.helarc.getSnapshot())).run
                ?.display.status,
          )
          .toBe("cancelled");
        const previews = await page.evaluate(
          (s) =>
            window.helarc.readResponsePreview({
              ...s,
              invocationId: null,
              cursor: null,
            }),
          scope,
        );
        expect(previews).toMatchObject({
          status: "page",
          attempts: [{ state: "cancelled" }],
        });
        await expect(page.locator(".wb-preview")).toContainText(
          "cancelled response",
        );
        expect(requests).toHaveLength(1);
      }
      await expect(
        access(join(userData, "workspace", "never-written.txt")),
      ).rejects.toThrow();
      expect(
        requests.every(
          (r) =>
            r.stream === true &&
            !r.messages.some((m: any) => m.role === "system"),
        ),
      ).toBe(true);
    } finally {
      response?.end();
      await app?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}

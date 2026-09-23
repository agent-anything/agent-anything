import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  HelarcResponsePreview,
  HelarcResponsePreviews,
} from "@agent-anything/helarc/run";
import { HelarcResponseProgress } from "./HelarcResponseProgress.js";

describe("coalesced response publication", () => {
  afterEach(() => vi.useRealTimers());
  it("bounds frames, coalesces chunks, signals resync and disposes without affecting the request", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const publisher = new HelarcResponseProgress(
      "sub",
      { threadId: "thread", productRunId: "work" },
      send,
    );
    const attempt: HelarcResponsePreview = {
      runId: "root",
      requestId: "request",
      controllerRequestId: "controller",
      invocationId: "attempt",
      revision: 1,
      deliverySequence: 1,
      mode: "streaming",
      state: "receiving",
      code: null,
      parts: [],
    };
    const state: HelarcResponsePreviews = {
      revision: 1,
      omittedAttempts: 0,
      retainedBytes: 0,
      attempts: [attempt],
    };
    publisher.observe(state, attempt);
    expect(send).toHaveBeenCalledOnce();
    for (let i = 1; i <= 500; i++)
      publisher.observe(
        { ...state, revision: i + 1 },
        {
          ...attempt,
          revision: i + 1,
          deliverySequence: i + 1,
          parts: [
            {
              id: "text:0",
              kind: "text",
              text: "x".repeat(i),
              receivedLength: i,
              omittedBytes: 0,
              name: null,
              modelItemId: null,
              turnId: null,
              committedRecordId: null,
            },
          ],
        },
      );
    expect(send).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(50);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![0]).toMatchObject({
      sequence: 2,
      previewRevision: 501,
      attempt: { parts: [{ offset: 0, text: "x".repeat(500) }] },
    });
    publisher.observe(
      { ...state, revision: 502 },
      {
        ...attempt,
        revision: 502,
        deliverySequence: 502,
        state: "interrupted",
        parts: [
          {
            id: "text:0",
            kind: "text",
            text: '"'.repeat(64000),
            receivedLength: 64000,
            omittedBytes: 0,
            name: null,
            modelItemId: null,
            turnId: null,
            committedRecordId: null,
          },
        ],
      },
    );
    expect(send.mock.calls.at(-1)![0].resyncRequired).toBe(true);
    for (const [frame] of send.mock.calls)
      expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(
        64 * 1024,
      );
    publisher.dispose();
    publisher.observe(state, attempt);
    vi.advanceTimersByTime(1000);
    expect(send).toHaveBeenCalledTimes(3);
  });
});

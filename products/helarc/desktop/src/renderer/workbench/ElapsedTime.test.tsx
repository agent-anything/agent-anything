import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ElapsedTime } from "./ElapsedTime.js";

const start = "2026-09-24T00:00:00Z";
afterEach(() => vi.useRealTimers());
describe("Elapsed time display", () => {
  it.each([0, 4, 5, 65])("applies the command threshold at %i seconds", seconds => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(start) + seconds * 1000);
    const html = renderToStaticMarkup(<ElapsedTime start={start} end={null} ticking minimumSeconds={5} />);
    expect(html).toBe(seconds < 5 ? "" : seconds < 60 ? `<small>${seconds}s</small>` : "<small>1m 5s</small>");
  });
  it("shows zero immediately without a threshold", () => {
    vi.useFakeTimers(); vi.setSystemTime(Date.parse(start));
    expect(renderToStaticMarkup(<ElapsedTime start={start} end={null} ticking />)).toBe("<small>0s</small>");
  });
  it("uses the recorded end time, not the time the result is opened", () => {
    expect(renderToStaticMarkup(<ElapsedTime start={start} end="2026-09-24T00:00:07Z" ticking={false} minimumSeconds={5} />)).toBe("<small>7s</small>");
    expect(renderToStaticMarkup(<ElapsedTime start={start} end="2026-09-24T00:00:03Z" ticking={false} minimumSeconds={5} />)).toBe("");
  });
  it("does not count time for inactive or unrecorded starts", () => {
    expect(renderToStaticMarkup(<ElapsedTime start={start} end={null} ticking={false} />)).toBe("");
    expect(renderToStaticMarkup(<ElapsedTime start={null} end={null} ticking />)).toBe("");
    expect(renderToStaticMarkup(<ElapsedTime start="invalid" end={null} ticking />)).toBe("");
  });
});

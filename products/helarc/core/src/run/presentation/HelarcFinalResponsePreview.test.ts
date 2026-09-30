import { describe, expect, it } from "vitest";
import { HelarcFinalResponsePreview } from "./HelarcFinalResponsePreview.js";

describe("final response argument preview", () => {
  it("decodes only the top-level response incrementally, including split escapes and Unicode", () => {
    const preview = new HelarcFinalResponsePreview();
    expect(preview.write('{"response":"Hello')).toEqual({ text: "Hello", omittedBytes: 0 });
    expect(preview.write(' \\"')).toEqual({ text: 'Hello "', omittedBytes: 0 });
    expect(preview.write('world\\n').text).toBe('Hello "world\n');
    expect(preview.write('\\u4e').text).toBe('Hello "world\n');
    expect(preview.write('2d"}').text).toBe('Hello "world\n\u4e2d');
  });

  it("preserves the exact complete response for every possible chunk boundary", () => {
    const response = '  Quotes: "yes", path: C:\\tmp\n\u4e2d\ud83d\ude00  ';
    const source = JSON.stringify({ response });
    for (let split = 0; split <= source.length; split++) {
      const preview = new HelarcFinalResponsePreview();
      preview.write(source.slice(0, split));
      expect(preview.write(source.slice(split))).toEqual({ text: response, omittedBytes: 0 });
    }
    const escaped = new HelarcFinalResponsePreview();
    for (const chunk of ['{"response":"\\uD8', '3D\\uDE', '00"}']) escaped.write(chunk);
    expect(escaped.write("")).toEqual({ text: "\ud83d\ude00", omittedBytes: 0 });
  });

  it("does not project nested values, nonstrings or repair malformed arguments", () => {
    expect(new HelarcFinalResponsePreview().write('{"nested":{"response":"other"},"response":""}'))
      .toEqual({ text: "", omittedBytes: 0 });
    expect(new HelarcFinalResponsePreview().write('{"response":42}').text).toBe("");
    const malformed = new HelarcFinalResponsePreview();
    expect(malformed.write('{"response":"candidate",broken').text).toBe("");
    expect(malformed.write('{"response":"cannot revive"}').text).toBe("");
    expect(new HelarcFinalResponsePreview().write('{"response":"first","response":"second"}').text).toBe("");
  });

  it.each([false, true])("previews only the response beside a final Plan snapshot (Plan first: %s)", planFirst => {
    const plan = [{step: "Inspect", status: "completed"}, {step: "Remaining work", status: "pending"}];
    const response = "Inspection finished; remaining work is unavailable.";
    const source = JSON.stringify(planFirst ? {plan, response} : {response, plan});
    for (let split = 0; split <= source.length; split++) {
      const preview = new HelarcFinalResponsePreview();
      preview.write(source.slice(0, split));
      expect(preview.write(source.slice(split))).toEqual({text: response, omittedBytes: 0});
    }
  });

  it("bounds raw argument parsing independently from authoritative interpretation", () => {
    const preview = new HelarcFinalResponsePreview();
    expect(preview.write('{"response":"early').text).toBe("early");
    expect(preview.write("x".repeat(129 * 1024)).text).toBe("early");
    expect(preview.write('"}').text).toBe("early");
  });
});

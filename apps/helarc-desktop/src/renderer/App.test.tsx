import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "./App.js";

describe("Helarc workbench shell", () => {
  it("renders the primary workbench surfaces", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain("Helarc");
    expect(html).toContain("No workspace selected");
    expect(html).toContain("No active session");
    expect(html).toContain("No pending review");
    expect(html).toContain("Templates");
  });
});

import { describe, expect, it } from "vitest";
import { createHelarcWindowOptions } from "./windowOptions.js";

describe("createHelarcWindowOptions", () => {
  it("isolates and sandboxes the renderer", () => {
    const options = createHelarcWindowOptions("C:/helarc/preload.cjs");

    expect(options).toMatchObject({
      minWidth: 900,
      minHeight: 640,
      show: false,
      webPreferences: {
        preload: "C:/helarc/preload.cjs",
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
  });
});

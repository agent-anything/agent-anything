import desktop from "../vitest.config.js";

// Explicit Windows foreground verification; the ordinary test entry is unchanged.
export default {
  ...desktop,
  test: {
    ...desktop.test,
    setupFiles: ["scripts/fixtures/foreground-test-setup.mjs"],
    maxWorkers: 1,
    minWorkers: 1,
    fileParallelism: false,
  },
};

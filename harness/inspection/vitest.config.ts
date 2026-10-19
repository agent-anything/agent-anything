import {defineConfig} from "vitest/config";

export default defineConfig({test: {
  // Real FULL-WAL pressure measurements must not compete with other storage fixtures.
  fileParallelism: false,
}});

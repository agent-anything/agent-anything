import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const currentDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: resolve(currentDir, "src/renderer"),
  base: "./",
  plugins: [react()],
  build: {
    outDir: resolve(currentDir, "dist/renderer"),
    emptyOutDir: true,
  },
});

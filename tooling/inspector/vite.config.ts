import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({ plugins: [react()], root: fileURLToPath(new URL(".", import.meta.url)), build: { outDir: "dist/renderer", emptyOutDir: true, sourcemap: true, chunkSizeWarningLimit: 3000, license: { fileName: "THIRD-PARTY-NOTICES.txt" } }, worker: { format: "es" } });

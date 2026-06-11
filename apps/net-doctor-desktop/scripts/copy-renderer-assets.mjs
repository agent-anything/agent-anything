import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const files = [
  ["src/preload/preload.cjs", "dist/preload/preload.cjs"],
  ["src/renderer/index.html", "dist/renderer/index.html"],
  ["src/renderer/styles.css", "dist/renderer/styles.css"],
];

for (const [from, to] of files) {
  const target = resolve(to);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(resolve(from), target);
}

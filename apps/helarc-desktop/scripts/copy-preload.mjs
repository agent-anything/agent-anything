import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const source = resolve("src/preload/preload.cjs");
const target = resolve("dist/preload/preload.cjs");
await mkdir(dirname(target), { recursive: true });
await copyFile(source, target);

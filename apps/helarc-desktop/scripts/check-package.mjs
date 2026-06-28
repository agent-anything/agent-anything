import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(join(appRoot, "package.json"), "utf8"));

const requiredFiles = [
  packageJson.main,
  "dist/preload/preload.cjs",
  "dist/renderer/index.html",
];

if (packageJson.type !== "module") {
  fail("package.json must keep type: module.");
}

if (packageJson.main !== "./dist/main/main.js") {
  fail("package.json main must point at ./dist/main/main.js.");
}

for (const relativePath of requiredFiles) {
  await assertExists(relativePath);
}

const assets = await readdir(join(appRoot, "dist/renderer/assets"));
if (!assets.some((name) => name.endsWith(".js"))) {
  fail("Renderer build must include a JavaScript asset.");
}

if (!assets.some((name) => name.endsWith(".css"))) {
  fail("Renderer build must include a CSS asset.");
}

const preload = await readFile(join(appRoot, "dist/preload/preload.cjs"), "utf8");
if (!preload.includes("contextBridge.exposeInMainWorld")) {
  fail("Preload build must expose the typed Helarc bridge.");
}

console.log("Helarc desktop packaging readiness check passed.");

async function assertExists(relativePath) {
  try {
    await access(join(appRoot, relativePath));
  } catch {
    fail(`Required package artifact is missing: ${relativePath}`);
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

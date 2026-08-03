import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(join(appRoot, "package.json"), "utf8"));
const appMetadata = JSON.parse(await readFile(join(appRoot, "app-metadata.json"), "utf8"));

const requiredFiles = [
  packageJson.main,
  "dist/preload/preload.cjs",
  "dist/renderer/index.html",
  appMetadata.iconAsset,
];

if (packageJson.type !== "module") {
  fail("package.json must keep type: module.");
}

if (packageJson.main !== "./dist/main/main.js") {
  fail("package.json main must point at ./dist/main/main.js.");
}

if (packageJson.productName !== appMetadata.displayName) {
  fail("package.json productName must match app metadata displayName.");
}

if (packageJson.appId !== appMetadata.appId) {
  fail("package.json appId must match app metadata appId.");
}

if (!packageJson.description || packageJson.description !== appMetadata.description) {
  fail("package.json description must match app metadata description.");
}

if (appMetadata.productId !== "helarc") {
  fail("app-metadata.json productId must be helarc.");
}

if (!appMetadata.iconAsset || !appMetadata.iconAsset.startsWith("assets/")) {
  fail("app-metadata.json must point at a packaged icon asset.");
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

const icon = await readFile(join(appRoot, appMetadata.iconAsset), "utf8");
if (!icon.includes("<svg") || !icon.includes("Helarc")) {
  fail("Icon asset must be a Helarc SVG source asset.");
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

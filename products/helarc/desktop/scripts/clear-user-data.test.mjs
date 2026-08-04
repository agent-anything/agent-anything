import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clearUserData } from "./clear-user-data.mjs";

describe("clear-user-data", () => {
  it("keeps all data during an explicit dry run", async () => {
    const paths = await createUserData();
    const messages = [];

    await clearUserData({
      ...paths,
      dryRun: true,
      log: (message) => messages.push(message),
    });

    await expect(access(paths.markerPath)).resolves.toBeUndefined();
    expect(messages).toEqual([
      `Would delete Helarc user data: ${paths.userDataPath}`,
    ]);
  });

  it("removes only the exact Helarc user-data directory", async () => {
    const paths = await createUserData();
    const siblingPath = join(paths.appDataPath, "OtherProduct", "keep.txt");
    await mkdir(join(paths.appDataPath, "OtherProduct"), { recursive: true });
    await writeFile(siblingPath, "keep", "utf8");

    await clearUserData({
      ...paths,
      log: () => undefined,
    });

    await expect(access(paths.userDataPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(siblingPath)).resolves.toBeUndefined();
  });
});

async function createUserData() {
  const appDataPath = await mkdtemp(join(tmpdir(), "helarc-reset-"));
  const productName = "Helarc";
  const userDataPath = join(appDataPath, productName);
  const markerPath = join(userDataPath, "current-store.json");
  await mkdir(userDataPath);
  await writeFile(markerPath, "current", "utf8");
  return {
    appDataPath,
    productName,
    userDataPath,
    markerPath,
  };
}

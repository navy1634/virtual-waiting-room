import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.ts",
  globalSetup: "./tests/e2e/global-setup.ts",
  workers: 1,
  timeout: 90_000,
  // Playwright は実行前に出力先を消すため、毎回別の一時ディレクトリを使う
  outputDir: join(
    tmpdir(),
    `virtual-waiting-room-results-${randomBytes(8).toString("hex")}`,
  ),
});

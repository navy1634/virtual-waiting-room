import { afterAll } from "bun:test";
import { startTestDatabase } from "./helpers/test-database.ts";

// Testcontainers の接続先で上書きし、app/.env の値をテストに使わない
const testDatabase = await startTestDatabase();
process.env.DATABASE_URL = testDatabase.url;
process.env.VWR_TEST_DATABASE_URL = testDatabase.url;
Object.assign(process.env, testDatabase.environment);
process.env.WAITING_ROOM_CAPACITY = "1";
// safety guard が専用 URL を確認できるよう、環境変数設定後に DB helper を読み込む
const { database } = await import("./helpers/database.ts");

// 全suiteの後に SQL pool を閉じてから、共有 PostgreSQL container を停止する
afterAll(async () => {
  try {
    await database.close();
  } finally {
    await testDatabase.stop();
  }
});

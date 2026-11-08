import { startTestDatabase } from "../helpers/test-database.ts";

export default async function globalSetup(): Promise<() => Promise<void>> {
  const testDatabase = await startTestDatabase();

  // Playwright はこの環境変数を worker へ引き継ぐ
  process.env.DATABASE_URL = testDatabase.url;
  process.env.VWR_TEST_DATABASE_URL = testDatabase.url;
  Object.assign(process.env, testDatabase.environment);
  process.env.WAITING_ROOM_CAPACITY = "1";

  // setup が返す関数は全 test 完了後に呼ばれる
  return async () => {
    await testDatabase.stop();
  };
}

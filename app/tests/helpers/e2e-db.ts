import {
  acquireTestDatabaseLock,
  database,
  resetTestDatabase,
  seedAuthenticatedSession,
  setWaitingExpired,
} from "./database.ts";

// Playwright の global setup が用意した URL に対して setup/seed/cleanup を実行する
type Action = "setup" | "seed" | "cleanup" | "expire-waiting";

const action = process.argv[2] as Action | undefined;

if (
  !action ||
  !["setup", "seed", "cleanup", "expire-waiting"].includes(action)
) {
  throw new Error("Expected one of: setup, seed, cleanup, expire-waiting");
}

async function run(): Promise<void> {
  const release = await acquireTestDatabaseLock();

  try {
    if (action === "expire-waiting") {
      const token = process.argv[3];
      if (!token) {
        throw new Error("A waiting session token is required");
      }
      await setWaitingExpired(token);
      return;
    }
    // reset と seed が稼働中 API の DB 操作と競合しないよう lock を保持する
    if (action === "setup") {
      await resetTestDatabase();
      return;
    }

    if (action === "cleanup") {
      await resetTestDatabase();
      return;
    }

    const subject = process.argv[3] ?? "browser-heartbeat";
    const token = await seedAuthenticatedSession(subject);
    process.stdout.write(`${token}\n`);
  } finally {
    await release();
  }
}

try {
  await run();
} finally {
  await database.close();
}

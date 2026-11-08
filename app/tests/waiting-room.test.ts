import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { SQL } from "bun";
import {
  acquireTestDatabaseLock,
  countActiveAdmissions,
  database,
  databaseUrl,
  readSession,
  resetTestDatabase,
  seedAuthenticatedSession,
  setLeaseExpired,
  setWaitingExpired,
} from "./helpers/database.ts";
import { queueRequest, responseBody } from "./helpers/http.ts";
import { startApiServer, type ApiServer } from "./helpers/server.ts";

setDefaultTimeout(30_000);

// queue の同時実行、FIFO 入場、lease 期限切れ、timeout 時の fail-closed を検証する
const WAITING_ROOM_API_APPLICATION_NAME = "vwr_waiting_room_test";
// この test file は OIDC を呼ばないが、必須設定として loopback URL を渡す
const TEST_OIDC_INTERNAL_URL = "http://127.0.0.1:1";

let server: ApiServer | undefined;
let extraServers: ApiServer[] = [];
let releaseTestDatabase: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const release = await acquireTestDatabaseLock();

  try {
    await resetTestDatabase();
    server = await startApiServer({
      applicationName: WAITING_ROOM_API_APPLICATION_NAME,
      internalUrl: TEST_OIDC_INTERNAL_URL,
    });
  } finally {
    await release();
  }
});

beforeEach(async () => {
  // suite 間で DB を共有するため、破壊的な fixture reset を lock で分離する
  releaseTestDatabase = await acquireTestDatabaseLock();
  await resetTestDatabase();
});

afterEach(async () => {
  await releaseTestDatabase?.();
  releaseTestDatabase = undefined;
});

afterAll(async () => {
  await Promise.all(extraServers.map((instance) => instance.stop()));
  await server?.stop();
});

function requireServer(): ApiServer {
  if (!server) {
    throw new Error("The test API server did not start");
  }

  return server;
}

async function installSessionUpdateDelay(
  statementDelaySeconds: number,
  deferredDelaySeconds?: number,
): Promise<() => Promise<void>> {
  if (![2.6, 3.5, 10].includes(statementDelaySeconds)) {
    throw new Error("Unsupported test-only session delay");
  }

  if (
    deferredDelaySeconds !== undefined &&
    ![2.6, 3.5, 10].includes(deferredDelaySeconds)
  ) {
    throw new Error("Unsupported test-only deferred delay");
  }

  await removeSessionUpdateDelay();
  try {
    await database.unsafe(`
      CREATE FUNCTION vwr_test_delay_session_update()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $test$
      BEGIN
        PERFORM pg_sleep(${statementDelaySeconds});
        RETURN NEW;
      END
      $test$
    `);
    await database.unsafe(`
      CREATE TRIGGER vwr_test_delay_session_update
      BEFORE UPDATE ON sessions
      FOR EACH ROW
      EXECUTE FUNCTION vwr_test_delay_session_update()
    `);

    if (deferredDelaySeconds !== undefined) {
      await database.unsafe(`
        CREATE FUNCTION vwr_test_deferred_session_delay()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $test$
        BEGIN
          PERFORM pg_sleep(${deferredDelaySeconds});
          RETURN NEW;
        END
        $test$
      `);
      await database.unsafe(`
        CREATE CONSTRAINT TRIGGER vwr_test_deferred_session_delay
        AFTER UPDATE ON sessions
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION vwr_test_deferred_session_delay()
      `);
    }

    return removeSessionUpdateDelay;
  } catch (error) {
    await removeSessionUpdateDelay();
    throw error;
  }
}

async function removeSessionUpdateDelay(): Promise<void> {
  await database.unsafe(
    "DROP TRIGGER IF EXISTS vwr_test_delay_session_update ON sessions",
  );
  await database.unsafe(
    "DROP TRIGGER IF EXISTS vwr_test_deferred_session_delay ON sessions",
  );
  await database.unsafe(
    "DROP FUNCTION IF EXISTS vwr_test_delay_session_update()",
  );
  await database.unsafe(
    "DROP FUNCTION IF EXISTS vwr_test_deferred_session_delay()",
  );
}

async function waitForSleepingApiQuery(): Promise<number> {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    const rows = await database.unsafe(`
      SELECT pid
      FROM pg_stat_activity
      WHERE datname = 'vwr_test'
        AND pid <> pg_backend_pid()
        AND state = 'active'
        AND wait_event = 'PgSleep'
    `);

    if (rows[0]) {
      return rows[0].pid;
    }

    await Bun.sleep(25);
  }

  throw new Error("No API SQL statement reached the test delay trigger");
}

async function waitForBackendToStop(pid: number): Promise<boolean> {
  const deadline = Date.now() + 2_000;

  while (Date.now() < deadline) {
    const rows = await database.unsafe(
      "SELECT state FROM pg_stat_activity WHERE pid = $1",
      [pid],
    );

    if (!rows[0] || rows[0].state !== "active") {
      return true;
    }

    await Bun.sleep(25);
  }

  return false;
}

test("100 件以上を複数 API プロセスへ同時投入しても有効枠は N 件以下", async () => {
  const capacity = 3;
  await resetTestDatabase();
  extraServers = await Promise.all(
    Array.from({ length: 3 }, () =>
      startApiServer({
        applicationName: WAITING_ROOM_API_APPLICATION_NAME,
        capacity,
        internalUrl: TEST_OIDC_INTERNAL_URL,
      }),
    ),
  );
  const servers = extraServers;
  const tokens = await Promise.all(
    Array.from({ length: 120 }, (_, index) =>
      seedAuthenticatedSession(`concurrent-${index}`),
    ),
  );

  const results = await Promise.all(
    tokens.map(async (token, index) => {
      const target = servers[index % servers.length]!;
      const response = await queueRequest(target, token, "POST");

      return { response, body: await responseBody(response) };
    }),
  );

  const accepted = results.filter(({ response }) => response.status === 200);
  const admitted = accepted.filter(
    ({ body }) =>
      typeof body === "object" &&
      body !== null &&
      "status" in body &&
      body.status === "admitted",
  );
  const rejectedByDeadline = results.filter(
    ({ response }) => response.status === 503,
  );

  expect(accepted.length + rejectedByDeadline.length).toBe(120);
  expect(admitted.length).toBeGreaterThan(0);
  expect(await countActiveAdmissions()).toBeLessThanOrEqual(capacity);
});

test("空きができても既存の待機者より新規利用者を先に入れない", async () => {
  const api = requireServer();
  const occupied = await seedAuthenticatedSession("fifo-occupied");
  const firstWaiting = await seedAuthenticatedSession("fifo-first");
  const secondWaiting = await seedAuthenticatedSession("fifo-second");
  const newArrival = await seedAuthenticatedSession("fifo-new-arrival");

  expect((await queueRequest(api, occupied, "POST")).status).toBe(200);
  expect((await queueRequest(api, firstWaiting, "POST")).status).toBe(200);
  expect((await queueRequest(api, secondWaiting, "POST")).status).toBe(200);
  expect((await queueRequest(api, occupied, "DELETE")).status).toBe(204);
  expect((await queueRequest(api, newArrival, "POST")).status).toBe(200);

  const first = await readSession(firstWaiting);
  const second = await readSession(secondWaiting);
  const newcomer = await readSession(newArrival);

  expect(first?.status).toBe("admitted");
  expect(second?.status).toBe("waiting");
  expect(newcomer?.status).toBe("waiting");
  expect(first?.queueOrder).toBeLessThan(second?.queueOrder ?? 0n);
  expect(second?.queueOrder).toBeLessThan(newcomer?.queueOrder ?? 0n);
});

test("同じ cookie の並列 join 再送は一つの位置と枠だけを維持する", async () => {
  const api = requireServer();
  const token = await seedAuthenticatedSession("replayed-join");
  const responses = await Promise.all([
    queueRequest(api, token, "POST"),
    queueRequest(api, token, "POST"),
  ]);

  expect(responses.map((response) => response.status)).toEqual([200, 200]);
  expect(await countActiveAdmissions()).toBe(1);

  const [session] = await database`
    SELECT count(*)::integer AS count
    FROM sessions
    WHERE subject = 'replayed-join'
  `;

  expect(session?.count).toBe(1);
});

test("退出の再送は冪等で、空いた枠を待機先頭へ渡す", async () => {
  const api = requireServer();
  const admitted = await seedAuthenticatedSession("leave-admitted");
  const waiting = await seedAuthenticatedSession("leave-waiting");

  await queueRequest(api, admitted, "POST");
  await queueRequest(api, waiting, "POST");

  expect((await queueRequest(api, admitted, "DELETE")).status).toBe(204);
  expect((await queueRequest(api, admitted, "DELETE")).status).toBe(204);
  expect((await readSession(waiting))?.status).toBe("admitted");
  expect(await countActiveAdmissions()).toBe(1);
});

test("期限切れの入場者が戻ると既存待機者の後ろに並ぶ", async () => {
  const api = requireServer();
  const formerAdmitted = await seedAuthenticatedSession("expired-lease");
  const existingWaiting = await seedAuthenticatedSession(
    "before-expired-lease",
  );

  await queueRequest(api, formerAdmitted, "POST");
  await queueRequest(api, existingWaiting, "POST");
  await setLeaseExpired(formerAdmitted);

  expect((await queueRequest(api, formerAdmitted, "POST")).status).toBe(200);

  const former = await readSession(formerAdmitted);
  const existing = await readSession(existingWaiting);

  expect(existing?.status).toBe("admitted");
  expect(former?.status).toBe("waiting");
  expect(existing?.queueOrder).toBeLessThan(former?.queueOrder ?? 0n);
});

test("60 秒間確認されなかった待機状態を整理し、再受付は末尾にする", async () => {
  const api = requireServer();
  const admitted = await seedAuthenticatedSession("waiting-expiry-occupant");
  const expiredWaiting = await seedAuthenticatedSession("waiting-expired");
  const laterWaiting = await seedAuthenticatedSession("waiting-later");

  await queueRequest(api, admitted, "POST");
  await queueRequest(api, expiredWaiting, "POST");
  await setWaitingExpired(expiredWaiting);

  const stalePoll = await queueRequest(api, expiredWaiting, "GET");
  const staleBody = await responseBody(stalePoll);
  const expiredState = await readSession(expiredWaiting);

  expect(stalePoll.status).toBe(409);
  expect(staleBody).toEqual({ code: "QUEUE_NOT_JOINED" });
  expect(expiredState?.status).toBe("idle");
  expect(expiredState?.queueOrder).toBeNull();
  expect(expiredState?.lastSeenAt).toBeNull();
  expect(expiredState?.leaseExpiresAt).toBeNull();

  await queueRequest(api, laterWaiting, "POST");
  await queueRequest(api, expiredWaiting, "POST");

  const earlier = await readSession(laterWaiting);
  const returned = await readSession(expiredWaiting);

  expect(earlier?.queueOrder).toBeLessThan(returned?.queueOrder ?? 0n);
});

test("queue advisory lock timeout は 503 を返し、入場を許可しない", async () => {
  const api = requireServer();
  const token = await seedAuthenticatedSession("lock-timeout");
  const lockConnection = await database.reserve();

  try {
    await lockConnection.unsafe("BEGIN");
    await lockConnection.unsafe("SELECT pg_advisory_xact_lock(197848626, 2)");

    const response = await queueRequest(api, token, "POST");
    const body = await responseBody(response);

    expect(response.status).toBe(503);
    expect(body).toEqual({ code: "UNAVAILABLE" });
    expect((await readSession(token))?.status).toBe("idle");
    expect(await countActiveAdmissions()).toBe(0);
  } finally {
    await lockConnection.unsafe("ROLLBACK");
    await lockConnection.release();
  }
});

test("statement timeout は503を返し、入場を許可しない", async () => {
  const api = requireServer();
  const token = await seedAuthenticatedSession("statement-timeout");
  const removeDelay = await installSessionUpdateDelay(3.5);

  try {
    const response = await queueRequest(api, token, "POST");
    const body = await responseBody(response);

    expect(response.status).toBe(503);
    expect(body).toEqual({ code: "UNAVAILABLE" });
    expect(response.headers.get("retry-after")).toBeTruthy();
    expect(response.headers.get("cache-control")).toContain("no-store");
  } finally {
    await removeDelay();
  }

  expect((await readSession(token))?.status).toBe("idle");
  expect(await countActiveAdmissions()).toBe(0);
});

test("transaction timeout は個別statementが期限内でも503で入場を拒否する", async () => {
  const api = requireServer();
  const token = await seedAuthenticatedSession("transaction-timeout");
  const removeDelay = await installSessionUpdateDelay(2.6, 2.6);

  try {
    const startedAt = Date.now();
    const response = await queueRequest(api, token, "POST");
    const elapsedMs = Date.now() - startedAt;
    const body = await responseBody(response);

    expect(response.status).toBe(503);
    expect(body).toEqual({ code: "UNAVAILABLE" });
    expect(response.headers.get("retry-after")).toBeTruthy();
    expect(elapsedMs).toBeGreaterThanOrEqual(4_500);
    expect(elapsedMs).toBeLessThan(8_000);
  } finally {
    await removeDelay();
  }

  expect((await readSession(token))?.status).toBe("idle");
  expect(await countActiveAdmissions()).toBe(0);
});

test("HTTP中断時に実行中のsession SQLをcancelし、入場を確定しない", async () => {
  const api = requireServer();
  const token = await seedAuthenticatedSession("cancelled-active-query");
  const removeDelay = await installSessionUpdateDelay(10);
  const controller = new AbortController();

  try {
    const request = fetch(`${api.origin}/queue`, {
      method: "POST",
      headers: {
        cookie: `vwr_session=${token}`,
        origin: api.origin,
      },
      signal: controller.signal,
    }).then(
      () => "resolved",
      (error: unknown) =>
        error instanceof Error ? error.name : "unknown-error",
    );
    const backendPid = await waitForSleepingApiQuery();

    controller.abort();
    expect(await request).toBe("AbortError");
    expect(await waitForBackendToStop(backendPid)).toBe(true);
  } finally {
    await removeDelay();
  }

  expect((await readSession(token))?.status).toBe("idle");
  expect(await countActiveAdmissions()).toBe(0);
});

test("DB 側の状態参照が失敗した場合は保護要求を許可しない", async () => {
  const api = requireServer();
  const token = await seedAuthenticatedSession("db-read-failure");

  await queueRequest(api, token, "POST");
  await database.unsafe(
    "ALTER TABLE sessions RENAME TO sessions_unavailable_test",
  );

  try {
    const response = await fetch(`${api.origin}/protected`, {
      headers: { cookie: `vwr_session=${token}` },
      signal: AbortSignal.timeout(10_000),
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBeTruthy();
  } finally {
    await database.unsafe(
      "ALTER TABLE sessions_unavailable_test RENAME TO sessions",
    );
  }
});

test("vwr_test が新規接続を拒否している間はAPIも許可せず503を返す", async () => {
  const api = requireServer();
  const token = await seedAuthenticatedSession("database-connection-denied");
  const unjoined = await queueRequest(api, token, "GET");
  expect(unjoined.status).toBe(409);
  const managementUrl = new URL(databaseUrl);
  managementUrl.pathname = "/postgres";
  const management = new SQL(managementUrl.toString(), { max: 2 });
  let control: Awaited<ReturnType<typeof management.reserve>> | undefined;
  let connectionsDisabled = false;

  try {
    const connection = await management.reserve();
    control = connection;
    const apiBackends = await connection.unsafe(
      `
        SELECT pid
        FROM pg_stat_activity
        WHERE datname = 'vwr_test'
          AND application_name = $1
          AND backend_type = 'client backend'
      `,
      [WAITING_ROOM_API_APPLICATION_NAME],
    );
    expect(apiBackends.length).toBeGreaterThan(0);

    connectionsDisabled = true;
    await connection.unsafe("ALTER DATABASE vwr_test ALLOW_CONNECTIONS false");

    const otherBackends = await connection.unsafe(
      `
        SELECT pid
        FROM pg_stat_activity
        WHERE datname = 'vwr_test'
          AND application_name = $1
          AND backend_type = 'client backend'
      `,
      [WAITING_ROOM_API_APPLICATION_NAME],
    );
    const terminated = await Promise.all(
      otherBackends.map(async ({ pid }: { pid: number }) => {
        const [result] = await connection.unsafe(
          "SELECT pg_terminate_backend($1, 1000) AS terminated",
          [pid],
        );

        return result?.terminated === true;
      }),
    );

    expect(terminated.every(Boolean)).toBe(true);

    const queueResponse = await queueRequest(api, token, "POST");
    const queueBody = await responseBody(queueResponse);
    const protectedResponse = await fetch(`${api.origin}/protected`, {
      headers: { cookie: `vwr_session=${token}` },
      signal: AbortSignal.timeout(10_000),
    });

    expect(queueResponse.status).toBe(503);
    expect(queueBody).toEqual({ code: "UNAVAILABLE" });
    expect(queueResponse.headers.get("retry-after")).toBeTruthy();
    expect(queueResponse.headers.get("cache-control")).toContain("no-store");
    expect(protectedResponse.status).toBe(503);
    expect(protectedResponse.headers.get("retry-after")).toBeTruthy();
    expect(protectedResponse.headers.get("cache-control")).toContain(
      "no-store",
    );
  } finally {
    try {
      if (connectionsDisabled && control) {
        const restoreConnections =
          "ALTER DATABASE vwr_test ALLOW_CONNECTIONS true";

        try {
          await control.unsafe(restoreConnections);
        } catch {
          await management.unsafe(restoreConnections);
        }
      }
    } finally {
      try {
        await control?.release();
      } finally {
        await management.close();
      }
    }
  }

  expect((await readSession(token))?.status).toBe("idle");
  expect(await countActiveAdmissions()).toBe(0);
});

import { createHash, randomBytes } from "node:crypto";
import { SQL } from "bun";

const TEST_DATABASE_NAME = "vwr_test";
const TEST_DATABASE_LOCK = "SELECT pg_advisory_lock(197848626, 1)";
const TEST_DATABASE_UNLOCK = "SELECT pg_advisory_unlock(197848626, 1)";

const configuredDatabaseUrl = Bun.env.DATABASE_URL;
const testContainerDatabaseUrl = Bun.env.VWR_TEST_DATABASE_URL;

// table の truncate や sequence の reset より先に、専用 test DB 以外を拒否する
if (
  !configuredDatabaseUrl ||
  configuredDatabaseUrl !== testContainerDatabaseUrl
) {
  throw new Error("Tests must use the database URL prepared by test setup");
}

const parsedDatabaseUrl = new URL(configuredDatabaseUrl);
const port = Number(parsedDatabaseUrl.port);

if (
  parsedDatabaseUrl.pathname !== `/${TEST_DATABASE_NAME}` ||
  !["127.0.0.1", "localhost"].includes(parsedDatabaseUrl.hostname) ||
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65535 ||
  parsedDatabaseUrl.username !== "waiting_room" ||
  !parsedDatabaseUrl.password
) {
  throw new Error(
    "Refusing to touch a database outside the dedicated vwr_test database",
  );
}

export const databaseUrl = configuredDatabaseUrl;
export const databaseEnvironment = {
  DATABASE_HOST: parsedDatabaseUrl.hostname,
  DATABASE_PORT: parsedDatabaseUrl.port,
  DATABASE_NAME: decodeURIComponent(parsedDatabaseUrl.pathname.slice(1)),
  DATABASE_USER: decodeURIComponent(parsedDatabaseUrl.username),
  DATABASE_PASSWORD: decodeURIComponent(parsedDatabaseUrl.password),
  DATABASE_SSLMODE: parsedDatabaseUrl.searchParams.get("sslmode") ?? "disable",
};
export const database = new SQL(databaseUrl, { max: 20 });

export async function acquireTestDatabaseLock(): Promise<() => Promise<void>> {
  const connection = await database.reserve();
  // 複数 suite が同じ DB を使う間、setup/reset/cleanup が重ならないようにする
  await connection.unsafe(TEST_DATABASE_LOCK);

  return async () => {
    try {
      await connection.unsafe(TEST_DATABASE_UNLOCK);
    } finally {
      await connection.release();
    }
  };
}

export async function resetTestDatabase(): Promise<void> {
  // 各 scenario の状態を揃えるため、行を消して FIFO の採番を戻す
  await database.unsafe("TRUNCATE TABLE oidc_transactions, sessions");
  await database.unsafe(
    "ALTER SEQUENCE waiting_room_queue_order_seq RESTART WITH 1",
  );
}

export async function seedAuthenticatedSession(
  subject: string,
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest();

  await database`
    INSERT INTO sessions (
      session_token_hash,
      subject,
      expires_at,
      status
    ) VALUES (
      ${tokenHash},
      ${subject},
      clock_timestamp() + INTERVAL '1 hour',
      'idle'
    )
  `;

  return token;
}

export async function seedExpiredAuthenticatedSession(
  subject: string,
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest();

  await database`
    INSERT INTO sessions (
      session_token_hash,
      subject,
      expires_at,
      status
    ) VALUES (
      ${tokenHash},
      ${subject},
      clock_timestamp() - INTERVAL '1 second',
      'idle'
    )
  `;

  return token;
}

export async function setLeaseExpired(token: string): Promise<void> {
  const tokenHash = createHash("sha256").update(token).digest();

  await database`
    UPDATE sessions
    SET lease_expires_at = clock_timestamp() - INTERVAL '1 second'
    WHERE session_token_hash = ${tokenHash}
  `;
}

export async function setWaitingExpired(token: string): Promise<void> {
  const tokenHash = createHash("sha256").update(token).digest();

  await database`
    UPDATE sessions
    SET last_seen_at = clock_timestamp() - INTERVAL '61 seconds'
    WHERE session_token_hash = ${tokenHash}
  `;
}

export async function setSessionExpired(token: string): Promise<void> {
  const tokenHash = createHash("sha256").update(token).digest();
  await database`
    UPDATE sessions
    SET expires_at = clock_timestamp() - INTERVAL '1 second'
    WHERE session_token_hash = ${tokenHash}
  `;
}

export async function readSession(token: string): Promise<{
  subject: string | null;
  expiresAt: Date;
  status: string;
  queueOrder: bigint | null;
  lastSeenAt: Date | null;
  leaseExpiresAt: Date | null;
} | null> {
  const tokenHash = createHash("sha256").update(token).digest();
  const [row] = await database`
    SELECT
      subject,
      expires_at AS "expiresAt",
      status,
      queue_order AS "queueOrder",
      last_seen_at AS "lastSeenAt",
      lease_expires_at AS "leaseExpiresAt"
    FROM sessions
    WHERE session_token_hash = ${tokenHash}
  `;

  if (!row) {
    return null;
  }

  return {
    ...row,
    queueOrder: row.queueOrder === null ? null : BigInt(row.queueOrder),
  };
}

export async function countActiveAdmissions(): Promise<number> {
  const [row] = await database`
    SELECT count(*)::integer AS count
    FROM sessions
    WHERE status = 'admitted'
      AND expires_at > clock_timestamp()
      AND lease_expires_at > clock_timestamp()
  `;

  return row?.count ?? 0;
}

export async function countSessionsForSubject(
  subject: string,
): Promise<number> {
  const [row] = await database`
    SELECT count(*)::integer AS count
    FROM sessions
    WHERE subject = ${subject}
  `;

  return row?.count ?? 0;
}

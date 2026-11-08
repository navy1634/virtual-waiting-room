// 待合状態を PostgreSQL に保存し、transaction lock で複数 process の入場を直列化する
import { createHash } from "node:crypto";
import { SQL } from "bun";
import type { QueueState } from "../../shared/queue.ts";
import { StoreUnavailableError } from "./errors.ts";

const CONNECTION_TIMEOUT_SECONDS = 2;
const POOL_ACQUIRE_TIMEOUT_MS = 2_000;
const TRANSACTION_TIMEOUT_MS = 5_000;
const ROLLBACK_TIMEOUT_MS = 1_000;
const LOCK_TIMEOUT = "1s";
const STATEMENT_TIMEOUT = "3s";
const TRANSACTION_TIMEOUT = "5s";
export const SESSION_LIFETIME_SECONDS = 3_600;
const OIDC_TRANSACTION_LIFETIME_SECONDS = 300;
const WAITING_TIMEOUT_SECONDS = 60;
const ADMISSION_LEASE_SECONDS = 120;
const QUEUE_LOCK_NAMESPACE = 197_848_626;
const QUEUE_LOCK_ID = 2;

type ReservedConnection = Awaited<
  ReturnType<InstanceType<typeof SQL>["reserve"]>
>;

type CancellableQuery<T> = Promise<T> & {
  active: boolean;
  cancel: () => unknown;
};

interface SessionRow {
  status: "idle" | "waiting" | "admitted";
  queueOrder: bigint | null;
  ahead: number | null;
}

interface OidcTransactionRow {
  nonce: string;
  pkceVerifier: string;
}

/** 業務上の拒否を throw せず、HTTP 層へ判別可能な結果として返す */
export type QueueResult<T> =
  | { value: T }
  | { error: "AUTH_REQUIRED" | "QUEUE_NOT_JOINED" | "NOT_ADMITTED" };

/** 生の session token を保存せず、DB lookup 用の SHA-256 hash にする */
function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

/** request abort と server 側期限を一つの signal にまとめる */
function combineSignals(...signals: AbortSignal[]): AbortSignal {
  return AbortSignal.any(signals);
}

/** 32 byte の base64url session token だけを DB lookup に使う */
function isExpectedSessionToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

/** AbortSignal を SQL query に接続し、期限超過時は実行中 query を取り消す */
async function execute<T>(
  query: CancellableQuery<T>,
  signal: AbortSignal,
): Promise<T> {
  const cancel = (): void => {
    query.cancel();
  };

  if (signal.aborted) {
    cancel();
  } else {
    signal.addEventListener("abort", cancel, { once: true });
  }

  try {
    return await query;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

// Bun.SQL の戻り値を unknown から各内部 row 型へ検証しながら変換する
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getRows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function queueOrderValue(value: unknown): bigint | null | undefined {
  if (value === null) {
    return null;
  }

  if (typeof value === "bigint") {
    return value;
  }

  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) {
    return BigInt(value);
  }

  return undefined;
}

function sessionRow(value: unknown): SessionRow | undefined {
  const row = getRows(value)[0];

  if (!row) {
    return undefined;
  }

  const status = row.status;
  const queueOrder = queueOrderValue(row.queueOrder);
  const ahead = row.ahead;

  if (
    (status !== "idle" && status !== "waiting" && status !== "admitted") ||
    queueOrder === undefined ||
    (ahead !== null && typeof ahead !== "number")
  ) {
    throw new StoreUnavailableError(new TypeError("Invalid sessions row"));
  }

  return { status, queueOrder, ahead };
}

function oidcTransactionRow(value: unknown): OidcTransactionRow | undefined {
  const row = getRows(value)[0];

  if (
    !row ||
    typeof row.nonce !== "string" ||
    typeof row.pkceVerifier !== "string"
  ) {
    return undefined;
  }

  return { nonce: row.nonce, pkceVerifier: row.pkceVerifier };
}

/** session・待機順・入場 lease・OIDC transaction の永続化境界 */
export class PostgresWaitingRoomStore {
  readonly #database: InstanceType<typeof SQL>;
  readonly #maxActiveSessions: number;

  constructor(databaseUrl: string, maxActiveSessions: number) {
    this.#database = new SQL(databaseUrl, {
      connectionTimeout: CONNECTION_TIMEOUT_SECONDS,
    });
    this.#maxActiveSessions = maxActiveSessions;
  }

  // session token と OIDC transaction cookie/state は hash で照合する
  // callback で必要な nonce と PKCE verifier は transaction と一緒に保存する
  /** session token の hash と認証 subject・期限を DB に登録する */
  async createAuthenticatedSession(
    token: string,
    subject: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (subject.length === 0) {
      throw new StoreUnavailableError(new TypeError("Invalid session subject"));
    }
    await this.#createSession(token, subject, signal);
  }

  async createAnonymousSession(
    token: string,
    signal: AbortSignal,
  ): Promise<void> {
    await this.#createSession(token, null, signal);
  }

  async #createSession(
    token: string,
    subject: string | null,
    signal: AbortSignal,
  ): Promise<void> {
    if (!isExpectedSessionToken(token)) {
      throw new StoreUnavailableError(new TypeError("Invalid session data"));
    }

    await this.#withConnection(signal, async (connection, querySignal) => {
      await execute<unknown>(
        connection.unsafe(
          `INSERT INTO sessions (
             session_token_hash,
             subject,
             expires_at,
             status
           ) VALUES (
             $1,
             $2,
             clock_timestamp() + ($3::double precision * INTERVAL '1 second'),
             'idle'
           )`,
          [hashToken(token), subject, SESSION_LIFETIME_SECONDS],
        ),
        querySignal,
      );
    });
  }

  /** callback で一回だけ使う state・nonce・PKCE verifier を期限付きで保存する */
  async createOidcTransaction(
    cookie: string,
    state: string,
    nonce: string,
    pkceVerifier: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (
      !isExpectedSessionToken(cookie) ||
      state.length < 32 ||
      nonce.length < 32 ||
      pkceVerifier.length < 43
    ) {
      throw new StoreUnavailableError(
        new TypeError("Invalid OIDC transaction"),
      );
    }

    await this.#withConnection(signal, async (connection, querySignal) => {
      await execute<unknown>(
        connection.unsafe(
          `DELETE FROM oidc_transactions
           WHERE expires_at <= clock_timestamp()`,
        ),
        querySignal,
      );
      await execute<unknown>(
        connection.unsafe(
          `INSERT INTO oidc_transactions (
             transaction_cookie_hash,
             state_hash,
             nonce,
             pkce_verifier,
             expires_at
           ) VALUES (
             $1,
             $2,
             $3,
             $4,
           clock_timestamp() + ($5::double precision * INTERVAL '1 second')
           )`,
          [
            hashToken(cookie),
            hashToken(state),
            nonce,
            pkceVerifier,
            OIDC_TRANSACTION_LIFETIME_SECONDS,
          ],
        ),
        querySignal,
      );
    });
  }

  /** cookie と state が一致する transaction を削除と同時に取得する */
  async consumeOidcTransaction(
    cookie: string,
    state: string,
    signal: AbortSignal,
  ): Promise<OidcTransactionRow | null> {
    if (!isExpectedSessionToken(cookie) || state.length < 32) {
      return null;
    }

    return this.#withConnection(signal, async (connection, querySignal) => {
      const rows = await execute<unknown>(
        connection.unsafe(
          `DELETE FROM oidc_transactions
           WHERE transaction_cookie_hash = $1
             AND state_hash = $2
             AND expires_at > clock_timestamp()
           RETURNING nonce, pkce_verifier AS "pkceVerifier"`,
          [hashToken(cookie), hashToken(state)],
        ),
        querySignal,
      );

      return oidcTransactionRow(rows) ?? null;
    });
  }

  /** 有効な session を待機列へ加え、空き枠があれば FIFO 順に入場させる */
  async join(
    token: string,
    signal: AbortSignal,
  ): Promise<QueueResult<QueueState>> {
    const tokenHash = isExpectedSessionToken(token) ? hashToken(token) : null;

    return this.#withQueueTransaction(
      signal,
      async (connection, querySignal) => {
        // DB 時刻の取得と期限切れ session の整理を済ませてから queue 状態を判定する
        const now = await this.#prepareQueueOperation(connection, querySignal);

        if (!tokenHash) {
          return { error: "AUTH_REQUIRED" };
        }

        let session = await this.#findSession(
          connection,
          tokenHash,
          querySignal,
        );

        if (!session) {
          return { error: "AUTH_REQUIRED" };
        }

        if (session.status === "idle") {
          // 初回 join だけで順番を割り当て、再送で待機者の順序を変えない
          await execute<unknown>(
            connection.unsafe(
              `UPDATE sessions
             SET status = 'waiting',
                 queue_order = nextval('waiting_room_queue_order_seq'),
                 last_seen_at = $2,
                 lease_expires_at = NULL
             WHERE session_token_hash = $1`,
              [tokenHash, now],
            ),
            querySignal,
          );
        } else if (session.status === "waiting") {
          // FIFO の位置は保ったまま、待機中であることだけを更新する
          await execute<unknown>(
            connection.unsafe(
              `UPDATE sessions
             SET last_seen_at = $2
             WHERE session_token_hash = $1`,
              [tokenHash, now],
            ),
            querySignal,
          );
        }

        await this.#promoteAvailable(connection, now, querySignal);
        session = await this.#findSession(connection, tokenHash, querySignal);

        return session
          ? { value: this.#toQueueState(session) }
          : { error: "AUTH_REQUIRED" };
      },
    );
  }

  /** 待機中の last_seen を更新し、現在位置と入場状態を返す */
  async poll(
    token: string,
    signal: AbortSignal,
  ): Promise<QueueResult<QueueState>> {
    const tokenHash = isExpectedSessionToken(token) ? hashToken(token) : null;

    return this.#withQueueTransaction(
      signal,
      async (connection, querySignal) => {
        const now = await this.#prepareQueueOperation(connection, querySignal);

        if (!tokenHash) {
          return { error: "AUTH_REQUIRED" };
        }

        const session = await this.#findSession(
          connection,
          tokenHash,
          querySignal,
        );

        if (!session) {
          return { error: "AUTH_REQUIRED" };
        }

        if (session.status === "idle") {
          return { error: "QUEUE_NOT_JOINED" };
        }

        if (session.status === "waiting") {
          await execute<unknown>(
            connection.unsafe(
              `UPDATE sessions
             SET last_seen_at = $2
             WHERE session_token_hash = $1`,
              [tokenHash, now],
            ),
            querySignal,
          );
          await this.#promoteAvailable(connection, now, querySignal);
        }

        const current = await this.#findSession(
          connection,
          tokenHash,
          querySignal,
        );

        return current
          ? { value: this.#toQueueState(current) }
          : { error: "AUTH_REQUIRED" };
      },
    );
  }

  /** 入場中の session に限って lease を延長する */
  async renew(
    token: string,
    signal: AbortSignal,
  ): Promise<QueueResult<QueueState>> {
    const tokenHash = isExpectedSessionToken(token) ? hashToken(token) : null;

    return this.#withQueueTransaction(
      signal,
      async (connection, querySignal) => {
        const now = await this.#prepareQueueOperation(connection, querySignal);

        if (!tokenHash) {
          return { error: "AUTH_REQUIRED" };
        }

        const session = await this.#findSession(
          connection,
          tokenHash,
          querySignal,
        );

        if (!session) {
          return { error: "AUTH_REQUIRED" };
        }

        if (session.status !== "admitted") {
          return { error: "NOT_ADMITTED" };
        }

        await execute<unknown>(
          connection.unsafe(
            `UPDATE sessions
           SET lease_expires_at = $2::timestamptz
                 + ($3::double precision * INTERVAL '1 second'),
               last_seen_at = $2
           WHERE session_token_hash = $1`,
            [tokenHash, now, ADMISSION_LEASE_SECONDS],
          ),
          querySignal,
        );

        const renewed = await this.#findSession(
          connection,
          tokenHash,
          querySignal,
        );

        return renewed
          ? { value: this.#toQueueState(renewed) }
          : { error: "AUTH_REQUIRED" };
      },
    );
  }

  /** 待機または入場状態を未参加へ戻し、空き枠を次の利用者へ回す */
  async leave(token: string, signal: AbortSignal): Promise<QueueResult<void>> {
    const tokenHash = isExpectedSessionToken(token) ? hashToken(token) : null;

    return this.#withQueueTransaction(
      signal,
      async (connection, querySignal) => {
        const now = await this.#prepareQueueOperation(connection, querySignal);

        if (!tokenHash) {
          return { error: "AUTH_REQUIRED" };
        }

        const session = await this.#findSession(
          connection,
          tokenHash,
          querySignal,
        );

        if (!session) {
          return { error: "AUTH_REQUIRED" };
        }

        if (session.status !== "idle") {
          await execute<unknown>(
            connection.unsafe(
              `UPDATE sessions
             SET status = 'idle',
                 queue_order = NULL,
                 last_seen_at = NULL,
                 lease_expires_at = NULL
             WHERE session_token_hash = $1`,
              [tokenHash],
            ),
            querySignal,
          );
          await this.#promoteAvailable(connection, now, querySignal);
        }

        return { value: undefined };
      },
    );
  }

  /** 保護 endpoint から呼ばれ、有効な入場 lease がある場合だけ許可する */
  async authorize(
    token: string,
    signal: AbortSignal,
  ): Promise<QueueResult<boolean>> {
    const tokenHash = isExpectedSessionToken(token) ? hashToken(token) : null;

    return this.#withQueueTransaction(
      signal,
      async (connection, querySignal) => {
        await this.#prepareQueueOperation(connection, querySignal);

        if (!tokenHash) {
          return { error: "AUTH_REQUIRED" };
        }

        const session = await this.#findSession(
          connection,
          tokenHash,
          querySignal,
        );

        if (!session) {
          return { error: "AUTH_REQUIRED" };
        }

        return { value: session.status === "admitted" };
      },
    );
  }

  /** server 終了時に Bun.SQL pool を閉じる */
  async close(): Promise<void> {
    await this.#database.close({ timeout: 2 });
  }

  /** queue 更新を一 transaction にまとめ、lock/statement/transaction の期限を設定する */
  async #withQueueTransaction<T>(
    signal: AbortSignal,
    action: (connection: ReservedConnection, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    // 容量判定と状態更新を同一 transaction にまとめ、queue lock 取得後に直列化する
    return this.#withConnection(signal, async (connection) => {
      const transactionSignal = combineSignals(
        signal,
        AbortSignal.timeout(TRANSACTION_TIMEOUT_MS),
      );

      try {
        // transaction 内だけに期限を設定し、終了時に接続全体の設定へ残さない
        await execute<unknown>(
          connection.unsafe("BEGIN ISOLATION LEVEL READ COMMITTED"),
          transactionSignal,
        );
        await execute<unknown>(
          connection.unsafe(
            `SELECT set_config('lock_timeout', $1, true),
                    set_config('statement_timeout', $2, true),
                    set_config('transaction_timeout', $3, true)`,
            [LOCK_TIMEOUT, STATEMENT_TIMEOUT, TRANSACTION_TIMEOUT],
          ),
          transactionSignal,
        );

        const value = await action(connection, transactionSignal);
        await execute<unknown>(connection.unsafe("COMMIT"), transactionSignal);
        return value;
      } catch (error) {
        // timeout 後も transaction は開いたままなので、connection を返す前に rollback する
        try {
          await execute<unknown>(
            connection.unsafe("ROLLBACK"),
            AbortSignal.timeout(ROLLBACK_TIMEOUT_MS),
          );
        } catch (rollbackError) {
          throw new StoreUnavailableError(rollbackError);
        }

        throw new StoreUnavailableError(error);
      }
    });
  }

  /** pool connection の取得に期限を設け、処理後は必ず pool へ返却する */
  async #withConnection<T>(
    signal: AbortSignal,
    action: (connection: ReservedConnection, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    let connection: ReservedConnection | undefined;

    try {
      const acquisitionSignal = combineSignals(
        signal,
        AbortSignal.timeout(POOL_ACQUIRE_TIMEOUT_MS),
      );
      connection = await this.#database.reserve({ signal: acquisitionSignal });
      return await action(connection, signal);
    } catch (error) {
      if (error instanceof StoreUnavailableError) {
        throw error;
      }

      throw new StoreUnavailableError(error);
    } finally {
      // 成功・timeout・中断のいずれでも、確保した connection を pool へ返す
      await connection?.release();
    }
  }

  /** queue transaction を直列化し、DB 時刻で期限切れ session を整理する */
  async #prepareQueueOperation(
    connection: ReservedConnection,
    signal: AbortSignal,
  ): Promise<Date> {
    // transaction 内の advisory lock で複数 app process の入場判定を直列化する
    await execute<unknown>(
      connection.unsafe("SELECT pg_advisory_xact_lock($1, $2)", [
        QUEUE_LOCK_NAMESPACE,
        QUEUE_LOCK_ID,
      ]),
      signal,
    );

    // replica ごとの時計差が出ないよう、期限判定には PostgreSQL の時刻を使う
    const clockRows = await execute<unknown>(
      connection.unsafe("SELECT clock_timestamp() AS now"),
      signal,
    );
    const nowValue = getRows(clockRows)[0]?.now;

    if (!(nowValue instanceof Date)) {
      throw new StoreUnavailableError(new TypeError("Invalid database clock"));
    }

    await execute<unknown>(
      connection.unsafe(
        `DELETE FROM sessions
         WHERE expires_at <= $1`,
        [nowValue],
      ),
      signal,
    );
    await execute<unknown>(
      connection.unsafe(
        `UPDATE sessions
         SET status = 'idle',
             queue_order = NULL,
             last_seen_at = NULL,
             lease_expires_at = NULL
         WHERE (status = 'waiting'
                AND last_seen_at <= $1::timestamptz
                  - ($2::double precision * INTERVAL '1 second'))
            OR (status = 'admitted'
                AND lease_expires_at <= $1::timestamptz)`,
        [nowValue, WAITING_TIMEOUT_SECONDS],
      ),
      signal,
    );
    return nowValue;
  }

  /** 使用枠を数え、空きがあれば queue_order の昇順で待機者を入場させる */
  async #promoteAvailable(
    connection: ReservedConnection,
    now: Date,
    signal: AbortSignal,
  ): Promise<void> {
    // 期限が有効な入場 lease だけを使用中の枠として数える
    const countRows = await execute<unknown>(
      connection.unsafe(
        `SELECT count(*)::integer AS count
         FROM sessions
         WHERE status = 'admitted'
           AND expires_at > $1
           AND lease_expires_at > $1`,
        [now],
      ),
      signal,
    );
    const count = getRows(countRows)[0]?.count;

    if (typeof count !== "number") {
      throw new StoreUnavailableError(new TypeError("Invalid admission count"));
    }

    const available = Math.max(0, this.#maxActiveSessions - count);

    if (available === 0) {
      return;
    }

    // queue_order 順に待機者をロックし、この transaction 内で入場 lease を割り当てる
    await execute<unknown>(
      connection.unsafe(
        `WITH next_waiting AS (
           SELECT session_token_hash
           FROM sessions
           WHERE status = 'waiting'
             AND expires_at > $1
           ORDER BY queue_order
           LIMIT $2
           FOR UPDATE
         )
         UPDATE sessions AS waiting
         SET status = 'admitted',
             lease_expires_at = $1::timestamptz
               + ($3::double precision * INTERVAL '1 second')
         FROM next_waiting
         WHERE waiting.session_token_hash = next_waiting.session_token_hash`,
        [now, available, ADMISSION_LEASE_SECONDS],
      ),
      signal,
    );
  }

  /** session row と、待機中なら前方にいる人数を取得する */
  async #findSession(
    connection: ReservedConnection,
    tokenHash: Buffer,
    signal: AbortSignal,
  ): Promise<SessionRow | undefined> {
    const rows = await execute<unknown>(
      connection.unsafe(
        `SELECT
           status,
           queue_order AS "queueOrder",
           CASE
             WHEN status = 'waiting' THEN (
               SELECT count(*)::integer
               FROM sessions AS earlier
               WHERE earlier.status = 'waiting'
                 AND earlier.queue_order < current.queue_order
             )
             ELSE NULL
           END AS ahead
         FROM sessions AS current
         WHERE session_token_hash = $1`,
        [tokenHash],
      ),
      signal,
    );

    return sessionRow(rows);
  }

  /** 内部 status を HTTP が返す waiting/admitted 状態へ写す */
  #toQueueState(session: SessionRow): QueueState {
    return {
      status: session.status === "admitted" ? "admitted" : "waiting",
      ahead: session.status === "waiting" ? session.ahead : null,
    };
  }
}

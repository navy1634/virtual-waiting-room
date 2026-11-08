-- migrate:up
CREATE SEQUENCE IF NOT EXISTS waiting_room_queue_order_seq
  AS bigint
  START WITH 1
  INCREMENT BY 1;

-- token の hash だけを保存し、status ごとの CHECK で queue/lease 列の整合性を保つ
CREATE TABLE IF NOT EXISTS sessions (
  session_token_hash bytea PRIMARY KEY
    CHECK (octet_length(session_token_hash) = 32),
  subject text CHECK (subject IS NULL OR length(subject) > 0),
  expires_at timestamptz NOT NULL,
  queue_order bigint UNIQUE,
  status text NOT NULL
    CHECK (status IN ('idle', 'waiting', 'admitted')),
  last_seen_at timestamptz,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (status = 'idle'
      AND queue_order IS NULL
      AND last_seen_at IS NULL
      AND lease_expires_at IS NULL)
    OR
    (status = 'waiting'
      AND queue_order IS NOT NULL
      AND last_seen_at IS NOT NULL
      AND lease_expires_at IS NULL)
    OR
    (status = 'admitted'
      AND queue_order IS NOT NULL
      AND last_seen_at IS NOT NULL
      AND lease_expires_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS sessions_waiting_order_idx
  ON sessions (queue_order)
  WHERE status = 'waiting';

CREATE INDEX IF NOT EXISTS sessions_admitted_expiry_idx
  ON sessions (lease_expires_at)
  WHERE status = 'admitted';

CREATE INDEX IF NOT EXISTS sessions_expiry_idx
  ON sessions (expires_at);

-- OIDC transaction は一回限りで期限付きとし、cookie token 自体は hash だけ保存する
CREATE TABLE IF NOT EXISTS oidc_transactions (
  transaction_cookie_hash bytea PRIMARY KEY
    CHECK (octet_length(transaction_cookie_hash) = 32),
  state_hash bytea NOT NULL UNIQUE
    CHECK (octet_length(state_hash) = 32),
  nonce text NOT NULL,
  pkce_verifier text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS oidc_transactions_expiry_idx
  ON oidc_transactions (expires_at);

-- migrate:down
DROP INDEX IF EXISTS oidc_transactions_expiry_idx;
DROP TABLE IF EXISTS oidc_transactions;
DROP INDEX IF EXISTS sessions_expiry_idx;
DROP INDEX IF EXISTS sessions_admitted_expiry_idx;
DROP INDEX IF EXISTS sessions_waiting_order_idx;
DROP TABLE IF EXISTS sessions;
DROP SEQUENCE IF EXISTS waiting_room_queue_order_seq;

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  acquireTestDatabaseLock,
  countSessionsForSubject,
  database,
  readSession,
  resetTestDatabase,
} from "./helpers/database.ts";
import { queueRequest, responseBody } from "./helpers/http.ts";
import {
  beginAuthorization,
  completeAuthorization,
  cookiePair,
  cookieValue,
  sendCallback,
} from "./helpers/oidc-flow.ts";
import {
  startFakeOidcProvider,
  type FakeOidcProvider,
  type OidcFault,
} from "./helpers/fake-oidc.ts";
import { startApiServer, type ApiServer } from "./helpers/server.ts";

setDefaultTimeout(30_000);

// ローカル issuer が応答を制御し、各 OIDC 検証失敗を決定的に再現する
let server: ApiServer | undefined;
let provider: FakeOidcProvider | undefined;
let releaseTestDatabase: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const release = await acquireTestDatabaseLock();

  try {
    await resetTestDatabase();
    provider = await startFakeOidcProvider();
    server = await startApiServer({
      issuerUrl: provider.issuer,
      internalUrl: provider.internalUrl,
    });
    provider.setExpectedRedirectUri(`${server.origin}/auth/callback`);
  } finally {
    await release();
  }
});

beforeEach(async () => {
  // 同じ DB を使う他の test file と fixture reset が重ならないようにする
  releaseTestDatabase = await acquireTestDatabaseLock();
  await resetTestDatabase();
});

afterEach(async () => {
  await releaseTestDatabase?.();
  releaseTestDatabase = undefined;
});

afterAll(async () => {
  await server?.stop();
  await provider?.stop();
});

function requireServer(): ApiServer {
  if (!server) {
    throw new Error("The test API server did not start");
  }

  return server;
}

function requireProvider(): FakeOidcProvider {
  if (!provider) {
    throw new Error("The test OIDC issuer did not start");
  }

  return provider;
}

function expectRedirect(response: Response): void {
  expect(response.status).toBeGreaterThanOrEqual(300);
  expect(response.status).toBeLessThan(400);
}

test("有効な OIDC callback の後も明示的な join まで queue に登録しない", async () => {
  const api = requireServer();
  const issuer = requireProvider();
  const started = await beginAuthorization(api.origin);
  const callbackUrl = await issuer.completeAuthorization(
    started.authorizationUrl,
  );
  const callback = await sendCallback(started, callbackUrl);
  const sessionCookie = cookiePair(callback, "vwr_session");
  const token = cookieValue(callback, "vwr_session");
  const sessionSetCookie = callback.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith("vwr_session="));

  expectRedirect(started.response);
  expect(started.transactionCookie).toBeTruthy();
  expectRedirect(callback);
  expect(callback.headers.get("cache-control")).toContain("no-store");
  expect(token).toBeTruthy();
  expect(sessionCookie).toBe(`vwr_session=${token}`);
  expect(sessionSetCookie).toContain("HttpOnly");
  expect(sessionSetCookie).toContain("SameSite=Lax");
  expect(sessionSetCookie).toContain("Path=/");
  expect(await countSessionsForSubject("test-subject")).toBe(1);

  const unjoined = await queueRequest(api, token!, "GET");

  expect(unjoined.status).toBe(409);
  expect(await responseBody(unjoined)).toEqual({ code: "QUEUE_NOT_JOINED" });
  expect((await readSession(token!))?.status).toBe("idle");

  const joined = await queueRequest(api, token!, "POST");
  const joinedBody = await responseBody(joined);

  expect(joined.status).toBe(200);
  expect(joinedBody).toMatchObject({ status: "admitted" });
  expect(
    typeof joinedBody === "object" &&
      joinedBody !== null &&
      "ahead" in joinedBody &&
      (joinedBody.ahead === null || typeof joinedBody.ahead === "number"),
  ).toBe(true);
  expect((await readSession(token!))?.status).toBe("admitted");
});

test("公開 issuer を維持したまま内部 OIDC service で callback を完了する", async () => {
  const publicIssuer = "https://127.0.0.1:1/api";
  const internalProvider = await startFakeOidcProvider("", publicIssuer);
  let api: ApiServer | undefined;

  try {
    api = await startApiServer({
      issuerUrl: publicIssuer,
      internalUrl: internalProvider.internalUrl,
    });
    internalProvider.setExpectedRedirectUri(`${api.origin}/auth/callback`);

    const started = await beginAuthorization(api.origin);

    expectRedirect(started.response);

    const authorizationUrl = new URL(started.authorizationUrl);
    const callbackUrl = await internalProvider.completeAuthorization(
      started.authorizationUrl,
    );
    const callback = await sendCallback(started, callbackUrl);

    expect(authorizationUrl.origin).toBe(new URL(publicIssuer).origin);
    expect(authorizationUrl.pathname).toBe("/api/authorize");
    expect(authorizationUrl.origin).not.toBe(
      new URL(internalProvider.internalUrl).origin,
    );
    expectRedirect(callback);
    expect(await countSessionsForSubject("test-subject")).toBe(1);
    expect(internalProvider.getRequestedPaths()).toEqual(
      expect.arrayContaining([
        "/api/.well-known/openid-configuration",
        "/api/token",
        "/api/jwks",
      ]),
    );
  } finally {
    await api?.stop();
    await internalProvider.stop();
  }
});

test("不正な state、PKCE、nonce、issuer、audience、署名、期限では session を発行しない", async () => {
  const api = requireServer();
  const issuer = requireProvider();
  const faults: OidcFault[] = [
    "wrong-state",
    "bad-pkce",
    "wrong-nonce",
    "wrong-issuer",
    "wrong-audience",
    "bad-signature",
    "expired-token",
  ];
  const unexpectedSessions: string[] = [];

  for (const fault of faults) {
    await resetTestDatabase();
    const started = await beginAuthorization(api.origin);
    const response = await completeAuthorization(
      issuer,
      started,
      undefined,
      fault,
    );

    expect(response.headers.get("cache-control")).toContain("no-store");
    const issuedCookie = cookieValue(response, "vwr_session") !== null;
    const sessionCount = await countSessionsForSubject("test-subject");

    if (issuedCookie || sessionCount > 0) {
      unexpectedSessions.push(
        `${fault}: cookie=${issuedCookie}, sessions=${sessionCount}`,
      );
    }
  }

  expect(unexpectedSessions).toEqual([]);
});

test("callback の再送は二つ目の待合室 session を発行しない", async () => {
  const api = requireServer();
  const issuer = requireProvider();
  const started = await beginAuthorization(api.origin);
  const callbackUrl = await issuer.completeAuthorization(
    started.authorizationUrl,
  );
  const first = await sendCallback(started, callbackUrl);
  const firstToken = cookieValue(first, "vwr_session");
  const replay = await sendCallback(started, callbackUrl);

  expectRedirect(first);
  expect(firstToken).toBeTruthy();
  expect(replay.status < 300 || replay.status >= 400).toBe(true);
  expect(cookieValue(replay, "vwr_session")).toBeNull();
  expect(await countSessionsForSubject("test-subject")).toBe(1);
  expect((await queueRequest(api, firstToken!, "GET")).status).toBe(409);
});

test("認証 callback の invalid redirect URI を issuer が拒否する", async () => {
  const api = requireServer();
  const started = await beginAuthorization(api.origin);
  const authorizationUrl = new URL(started.authorizationUrl);
  authorizationUrl.searchParams.set(
    "redirect_uri",
    `${api.origin}/different-callback`,
  );
  const rejected = await fetch(authorizationUrl);
  const [sessions] = await database`
    SELECT count(*)::integer AS count
    FROM sessions
  `;

  expect(rejected.status).toBe(400);
  expect(sessions?.count).toBe(0);
});

test("OIDC token endpoint の timeout は503を返し session を発行しない", async () => {
  const api = requireServer();
  const issuer = requireProvider();
  issuer.setTokenResponseDelay(9_000);

  try {
    const started = await beginAuthorization(api.origin);
    const callback = await completeAuthorization(issuer, started);

    expect(callback.status).toBe(503);
    expect(callback.headers.get("cache-control")).toContain("no-store");
    expect(callback.headers.get("retry-after")).toBeTruthy();
    expect(cookieValue(callback, "vwr_session")).toBeNull();
    expect(await countSessionsForSubject("test-subject")).toBe(0);
  } finally {
    issuer.setTokenResponseDelay(0);
  }
});

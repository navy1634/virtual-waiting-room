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
  countActiveAdmissions,
  readSession,
  resetTestDatabase,
  seedAuthenticatedSession,
  seedExpiredAuthenticatedSession,
  setSessionExpired,
} from "./helpers/database.ts";
import { queueRequest, responseBody } from "./helpers/http.ts";
import {
  beginAuthorization,
  completeAuthorization,
  cookieValue,
} from "./helpers/oidc-flow.ts";
import {
  startFakeOidcProvider,
  type FakeOidcProvider,
} from "./helpers/fake-oidc.ts";
import { startApiServer, type ApiServer } from "./helpers/server.ts";

setDefaultTimeout(30_000);

// route の status、cache header、origin 検査、保護応答を確認する
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
      appReturnOrigin: "https://app.sandbox.navy1634.com",
      sessionCookieDomain: ".navy1634.com",
    });
    provider.setExpectedRedirectUri(`${server.origin}/auth/callback`);
  } finally {
    await release();
  }
});

beforeEach(async () => {
  // 共有 test DB の lock を取得してから状態を reset する
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

function expectNoStore(response: Response): void {
  expect(response.headers.get("cache-control")?.toLowerCase()).toContain(
    "no-store",
  );
}

async function enterWaitingRoom(
  api: ApiServer,
  returnTo: string,
  token?: string,
): Promise<Response> {
  const url = new URL("/", api.origin);
  url.searchParams.set("return_to", returnTo);
  return fetch(url, {
    redirect: "manual",
    headers: token ? { cookie: `vwr_session=${token}` } : {},
  });
}

test("直接アクセスは設定済みoriginの自動入場へredirectし、空席ならアプリへ戻す", async () => {
  const api = requireServer();
  const issuerRequests = requireProvider().getRequestedPaths();
  const direct = await fetch(`${api.origin}/`, { redirect: "manual" });
  expect(direct.status).toBe(302);
  expectNoStore(direct);
  const entry = new URL(direct.headers.get("location")!);
  expect(entry.origin).toBe(api.origin);
  expect(entry.pathname).toBe("/");
  expect(entry.searchParams.get("return_to")).toBe(
    "https://app.sandbox.navy1634.com/",
  );
  expect(cookieValue(direct, "vwr_session")).toBeNull();
  const admitted = await fetch(entry, { redirect: "manual" });
  expect(admitted.status).toBe(302);
  expect(admitted.headers.get("location")).toBe(
    "https://app.sandbox.navy1634.com/",
  );
  const token = cookieValue(admitted, "vwr_session");
  expect(token).toBeTruthy();
  expect((await readSession(token!))?.status).toBe("admitted");
  expect(requireProvider().getRequestedPaths()).toEqual(issuerRequests);
});

test("満席の直接アクセスは匿名で待機し、枠が空けば設定済みアプリへ戻す", async () => {
  const api = requireServer();
  const occupant = await seedAuthenticatedSession("direct-occupant");
  await queueRequest(api, occupant, "POST");
  const direct = await fetch(`${api.origin}/`, { redirect: "manual" });
  expect(direct.status).toBe(302);
  const entry = new URL(direct.headers.get("location")!);
  const waiting = await fetch(entry, { redirect: "manual" });
  expect(waiting.status).toBe(200);
  const token = cookieValue(waiting, "vwr_session");
  expect(token).toBeTruthy();
  expect((await readSession(token!))?.status).toBe("waiting");
  await queueRequest(api, occupant, "DELETE");
  const admitted = await fetch(entry, {
    redirect: "manual",
    headers: { cookie: `vwr_session=${token}` },
  });
  expect(admitted.status).toBe(302);
  expect(admitted.headers.get("location")).toBe(
    "https://app.sandbox.navy1634.com/",
  );
});

test("認証開始 redirect は正確な callback と no-store を返す", async () => {
  const api = requireServer();
  const started = await beginAuthorization(api.origin);
  const authorizationUrl = new URL(started.authorizationUrl);

  expect(started.response.status).toBe(302);
  expectNoStore(started.response);
  expect(started.transactionCookie?.startsWith("vwr_oidc=")).toBe(true);
  expect(authorizationUrl.origin).toBe(requireProvider().issuer);
  expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
    `${api.origin}/auth/callback`,
  );
  expect(authorizationUrl.searchParams.get("scope")?.split(/\s+/)).toContain(
    "openid",
  );
  expect(authorizationUrl.searchParams.get("state")).toBeTruthy();
  expect(authorizationUrl.searchParams.get("nonce")).toBeTruthy();
  expect(authorizationUrl.searchParams.get("code_challenge")).toBeTruthy();
  expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe(
    "S256",
  );
});

test("匿名アクセスは認証せず空き枠を確保し、path・query・fragmentを保って元URLへ戻る", async () => {
  const api = requireServer();
  const returnTo =
    "https://app.sandbox.navy1634.com/orders/42?tab=detail#payment";
  const issuerRequests = requireProvider().getRequestedPaths();
  const callback = await enterWaitingRoom(api, returnTo);
  const token = cookieValue(callback, "vwr_session");

  expect(callback.status).toBe(302);
  expect(callback.headers.get("location")).toBe(returnTo);
  expectNoStore(callback);
  expect(token).toBeTruthy();
  expect(cookieValue(callback, "vwr_oidc")).toBeNull();
  expect(requireProvider().getRequestedPaths()).toEqual(issuerRequests);
  expect((await readSession(token!))?.subject).toBeNull();
  expect((await readSession(token!))?.status).toBe("admitted");
  expect(await countActiveAdmissions()).toBe(1);
  const sessionCookie = callback.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith("vwr_session="));
  expect(sessionCookie).toMatch(/;\s*Domain=\.?navy1634\.com(?:;|$)/i);
});

test("SESSION_COOKIE_DOMAIN を指定した認証 callback は session cookie に Domain を付ける", async () => {
  const started = await beginAuthorization(requireServer().origin);
  const callback = await completeAuthorization(requireProvider(), started);
  const sessionCookie = callback.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith("vwr_session="));

  expect(sessionCookie).toBeTruthy();
  expect(sessionCookie).toMatch(/;\s*Domain=\.?navy1634\.com(?:;|$)/i);
  expect(sessionCookie).toContain("HttpOnly");
  expect(sessionCookie).toContain("SameSite=Lax");
});

test("満席の匿名アクセスは自動参加し、既存の待機者より後ろで入場を待つ", async () => {
  const api = requireServer();
  const occupant = await seedAuthenticatedSession("return-occupant");
  const predecessor = await seedAuthenticatedSession("return-predecessor");
  await queueRequest(api, occupant, "POST");
  await queueRequest(api, predecessor, "POST");
  const callback = await enterWaitingRoom(
    api,
    "https://app.sandbox.navy1634.com/orders?filter=open#latest",
  );
  const token = cookieValue(callback, "vwr_session");

  expect(token).toBeTruthy();
  expect(callback.status).toBe(200);
  expect(callback.headers.get("location")).toBeNull();
  expect(cookieValue(callback, "vwr_oidc")).toBeNull();
  expect((await readSession(token!))?.status).toBe("waiting");
  expect((await readSession(token!))!.queueOrder!).toBeGreaterThan(
    (await readSession(predecessor))!.queueOrder!,
  );
  expect(
    await responseBody(await queueRequest(api, token!, "GET")),
  ).toMatchObject({
    status: "waiting",
    ahead: 1,
  });
  await queueRequest(api, occupant, "DELETE");
  expect(
    await responseBody(await queueRequest(api, token!, "GET")),
  ).toMatchObject({ status: "waiting" });
  expect((await readSession(predecessor))?.status).toBe("admitted");
  await queueRequest(api, predecessor, "DELETE");
  expect(
    await responseBody(await queueRequest(api, token!, "GET")),
  ).toMatchObject({ status: "admitted" });
});

test("空き枠への匿名同時アクセスは容量を超えず一人だけ戻し、もう一人は待機させる", async () => {
  const api = requireServer();
  const returnTo = "https://app.sandbox.navy1634.com/concurrent";
  const callbacks = await Promise.all([
    enterWaitingRoom(api, returnTo),
    enterWaitingRoom(api, returnTo),
  ]);
  const tokens = callbacks.map((response) =>
    cookieValue(response, "vwr_session"),
  );

  expect(tokens.every(Boolean)).toBe(true);
  expect(new Set(tokens).size).toBe(2);
  expect(await countActiveAdmissions()).toBe(1);
  expect(
    callbacks.filter(
      (response) => response.headers.get("location") === returnTo,
    ),
  ).toHaveLength(1);
  const sessions = await Promise.all(
    tokens.map((token) => readSession(token!)),
  );
  expect(sessions.map((session) => session?.status)).toEqual(
    expect.arrayContaining(["admitted", "waiting"]),
  );
});

test("匿名sessionの再アクセスは同じ入場枠を使い、退出後もsubjectを持たない", async () => {
  const api = requireServer();
  const returnTo = "https://app.sandbox.navy1634.com/revisit";
  const first = await enterWaitingRoom(api, returnTo);
  const token = cookieValue(first, "vwr_session");
  expect(token).toBeTruthy();
  const second = await enterWaitingRoom(api, returnTo, token!);
  expect(second.headers.get("location")).toBe(returnTo);
  expect(cookieValue(second, "vwr_session")).toBeNull();
  expect(await countActiveAdmissions()).toBe(1);
  expect((await queueRequest(api, token!, "DELETE")).status).toBe(204);
  expect(await readSession(token!)).toMatchObject({
    subject: null,
    status: "idle",
  });
  expect(
    (await enterWaitingRoom(api, returnTo, token!)).headers.get("location"),
  ).toBe(returnTo);
});

test("匿名sessionは1時間で失効し、再アクセスでは別のtokenで再入場する", async () => {
  const api = requireServer();
  const returnTo = "https://app.sandbox.navy1634.com/expired";
  const first = await enterWaitingRoom(api, returnTo);
  const token = cookieValue(first, "vwr_session")!;
  expect(token).toBeTruthy();
  const expiresIn =
    (await readSession(token))!.expiresAt.getTime() - Date.now();
  expect(expiresIn).toBeGreaterThan(3_500_000);
  expect(expiresIn).toBeLessThanOrEqual(3_601_000);
  await setSessionExpired(token);
  const next = await enterWaitingRoom(api, returnTo, token);
  const nextToken = cookieValue(next, "vwr_session");
  expect(nextToken).toBeTruthy();
  expect(nextToken).not.toBe(token);
  expect(next.headers.get("location")).toBe(returnTo);
  expect(await readSession(token)).toBeNull();
  expect((await readSession(nextToken!))?.subject).toBeNull();
  expect(await countActiveAdmissions()).toBe(1);
});

test("Domain未設定の匿名sessionはhost限定Cookieを発行する", async () => {
  const api = await startApiServer({
    internalUrl: "http://127.0.0.1:1",
    appReturnOrigin: "https://app.sandbox.navy1634.com",
  });
  try {
    const response = await enterWaitingRoom(
      api,
      "https://app.sandbox.navy1634.com/host-only",
    );
    expect(response.status).toBe(302);
    const cookie = response.headers
      .getSetCookie()
      .find((value) => value.startsWith("vwr_session="));
    expect(cookie).toBeTruthy();
    expect(cookie).not.toMatch(/;\s*Domain=/i);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  } finally {
    await api.stop();
  }
});

test("return_to の scheme・host・port が設定 origin と違えば外部へ戻さない", async () => {
  const api = requireServer();
  const invalidReturns = [
    "https://attacker.example/orders",
    "https://app.sandbox.navy1634.com.attacker.example/orders",
    "https://app.sandbox.navy1634.com@attacker.example/orders",
    "http://app.sandbox.navy1634.com/orders",
    "https://app.sandbox.navy1634.com:444/orders",
    "//attacker.example/orders",
  ];

  for (const returnTo of invalidReturns) {
    const response = await enterWaitingRoom(api, returnTo);
    expect(response.status).toBe(400);
    expect(cookieValue(response, "vwr_session")).toBeNull();
    const location = response.headers.get("location");
    if (location) {
      expect(new URL(location, api.origin).origin).toBe(api.origin);
    }
    expectNoStore(response);
  }
});

test("return_to付きauth/startはOIDCを開始せず拒否する", async () => {
  const before = requireProvider().getRequestedPaths();
  const started = await beginAuthorization(
    requireServer().origin,
    "https://app.sandbox.navy1634.com/orders",
  );
  expect(started.response.status).toBe(400);
  expect(started.response.headers.get("location")).toBeNull();
  expect(cookieValue(started.response, "vwr_oidc")).toBeNull();
  expect(requireProvider().getRequestedPaths()).toEqual(before);
});

test("未認証の queue API と protected は許可せず no-store を返す", async () => {
  const api = requireServer();
  const cases = [
    { method: "GET", path: "/queue" },
    { method: "POST", path: "/queue" },
    { method: "POST", path: "/queue/renew" },
    { method: "DELETE", path: "/queue" },
    { method: "GET", path: "/protected" },
  ] as const;

  for (const { method, path } of cases) {
    const headers = new Headers();

    if (method !== "GET") {
      headers.set("origin", api.origin);
    }

    const response = await fetch(`${api.origin}${path}`, { method, headers });

    expect(response.status).toBe(401);
    expectNoStore(response);

    if (path !== "/protected") {
      expect(await responseBody(response)).toEqual({ code: "AUTH_REQUIRED" });
    } else {
      expect(await response.text()).toContain("AUTH_REQUIRED");
    }
  }

  const callback = await fetch(`${api.origin}/auth/callback`, {
    redirect: "manual",
  });

  expect(callback.status).toBeGreaterThanOrEqual(400);
  expectNoStore(callback);
});

test("認証済みでも未登録なら poll と renew は別の409 codeを返す", async () => {
  const api = requireServer();
  const token = await seedAuthenticatedSession("authenticated-not-queued");
  const poll = await queueRequest(api, token, "GET");
  const renew = await queueRequest(api, token, "POST", "/queue/renew");
  const protectedPage = await fetch(`${api.origin}/protected`, {
    headers: { cookie: `vwr_session=${token}` },
  });

  expect(poll.status).toBe(409);
  expect(await responseBody(poll)).toEqual({ code: "QUEUE_NOT_JOINED" });
  expect(renew.status).toBe(409);
  expect(await responseBody(renew)).toEqual({ code: "NOT_ADMITTED" });
  expect(protectedPage.status).toBe(403);
  expect(await protectedPage.text()).toContain("ADMISSION_REQUIRED");
  expectNoStore(poll);
  expectNoStore(renew);
  expectNoStore(protectedPage);
  expect((await readSession(token))?.status).toBe("idle");
});

test("入場済みの queue と protected 成功応答にも no-store を付ける", async () => {
  const api = requireServer();
  const token = await seedAuthenticatedSession("admitted-cache-control");
  const joined = await queueRequest(api, token, "POST");
  const polled = await queueRequest(api, token, "GET");
  const renewed = await queueRequest(api, token, "POST", "/queue/renew");
  const protectedPage = await fetch(`${api.origin}/protected`, {
    headers: { cookie: `vwr_session=${token}` },
  });
  const left = await queueRequest(api, token, "DELETE");

  expect(joined.status).toBe(200);
  expect(polled.status).toBe(200);
  expect(renewed.status).toBe(200);
  expect(protectedPage.status).toBe(200);
  expect(left.status).toBe(204);
  for (const response of [joined, polled, renewed, protectedPage, left]) {
    expectNoStore(response);
  }
  expect(await countActiveAdmissions()).toBe(0);
});

test("Origin が異なる state-changing API は拒否し状態を変えない", async () => {
  const api = requireServer();
  const token = await seedAuthenticatedSession("origin-rejected");
  const response = await fetch(`${api.origin}/queue`, {
    method: "POST",
    headers: {
      cookie: `vwr_session=${token}`,
      origin: "https://attacker.example",
    },
  });

  expect(response.status).toBe(403);
  expectNoStore(response);
  expect((await readSession(token))?.status).toBe("idle");
});

test("期限切れの認証 session は削除され protected を許可しない", async () => {
  const api = requireServer();
  const token = await seedExpiredAuthenticatedSession("expired-auth");
  const response = await fetch(`${api.origin}/protected`, {
    headers: { cookie: `vwr_session=${token}` },
  });

  expect(response.status).toBe(401);
  expect(await response.text()).toContain("AUTH_REQUIRED");
  expectNoStore(response);
  expect(await readSession(token)).toBeNull();
  expect(cookieValue(response, "vwr_session")).toBe("");
});

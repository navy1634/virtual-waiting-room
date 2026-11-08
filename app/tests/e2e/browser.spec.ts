import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test, type Page } from "@playwright/test";
let returnServer: ReturnType<typeof Bun.serve> | undefined;
let appReturnOrigin = "";

const projectRoot = process.cwd();
const databaseUrl = process.env.DATABASE_URL;
const databaseEnvironment = {
  DATABASE_HOST: process.env.DATABASE_HOST ?? "",
  DATABASE_PORT: process.env.DATABASE_PORT ?? "",
  DATABASE_NAME: process.env.DATABASE_NAME ?? "",
  DATABASE_USER: process.env.DATABASE_USER ?? "",
  DATABASE_PASSWORD: process.env.DATABASE_PASSWORD ?? "",
  DATABASE_SSLMODE: process.env.DATABASE_SSLMODE ?? "",
};

// Playwright global setup が設定した URL でなければ、テストを開始しない
if (
  !databaseUrl ||
  databaseUrl !== process.env.VWR_TEST_DATABASE_URL ||
  Object.values(databaseEnvironment).some((value) => value.length === 0)
) {
  throw new Error(
    "E2E tests must use the database URL prepared by Playwright global setup",
  );
}

interface ApiProcess {
  origin: string;
  child: ChildProcess;
  stop: () => Promise<void>;
}

let api: ApiProcess | undefined;
let standaloneApi: ApiProcess | undefined;

function runDatabaseAction(
  action: "setup" | "seed" | "cleanup" | "expire-waiting",
  token?: string,
): string {
  // helper には test URL だけを渡し、app/.env の認証情報は引き継がない
  const result = spawnSync(
    process.execPath,
    [
      "--no-env-file",
      "tests/helpers/e2e-db.ts",
      action,
      ...(token ? [token] : []),
    ],
    {
      cwd: projectRoot,
      env: {
        PATH: process.env.PATH ?? "",
        ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
        DATABASE_URL: databaseUrl,
        VWR_TEST_DATABASE_URL: databaseUrl,
      },
      encoding: "utf8",
      timeout: 15_000,
    },
  );

  if (result.error || result.status !== 0) {
    const diagnostic = result.error?.message ?? result.stderr.trim();
    const redactedDiagnostic = diagnostic
      .replaceAll(databaseUrl!, "[redacted database URL]")
      .replaceAll(new URL(databaseUrl!).password, "[redacted password]");
    const safeDiagnostic = token
      ? redactedDiagnostic.replaceAll(token, "[redacted token]")
      : redactedDiagnostic;

    throw new Error(
      `The vwr_test database ${action} action failed: ${safeDiagnostic}`,
    );
  }

  return result.stdout.trim();
}

async function findFreePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });

  const address = probe.address();

  if (!address || typeof address === "string") {
    throw new Error("Could not allocate a local API port");
  }

  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });

  return address.port;
}

async function startApi(returnOrigin = appReturnOrigin): Promise<ApiProcess> {
  const port = await findFreePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    ["--no-env-file", "src/server/http/server.ts"],
    {
      cwd: projectRoot,
      env: {
        PATH: process.env.PATH ?? "",
        ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
        ...databaseEnvironment,
        WAITING_ROOM_CAPACITY: "1",
        APP_ORIGIN: origin,
        ...(returnOrigin ? { APP_RETURN_ORIGIN: returnOrigin } : {}),
        OIDC_ISSUER_URL: "http://127.0.0.1:1",
        OIDC_INTERNAL_URL: "http://127.0.0.1:1",
        OIDC_CLIENT_ID: "test-client",
        OIDC_CLIENT_SECRET: "test-client-secret",
        OIDC_REDIRECT_URI: `${origin}/auth/callback`,
        HOST: "127.0.0.1",
        PORT: String(port),
      },
      stdio: "ignore",
    },
  );

  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error("The API process exited before serving GET /");
    }

    try {
      const response = await fetch(`${origin}/`, {
        redirect: "manual",
        signal: AbortSignal.timeout(250),
      });

      if (response.status === 200 || response.status === 302) {
        return {
          origin,
          child,
          stop: async () => {
            if (child.exitCode === null) {
              const exited = once(child, "exit");
              child.kill("SIGTERM");
              await exited;
            }
          },
        };
      }
    } catch {
      await delay(50);
    }
  }

  child.kill("SIGTERM");
  throw new Error("The API process did not serve GET / within five seconds");
}

test.setTimeout(90_000);

test.beforeAll(async () => {
  runDatabaseAction("setup");
  returnServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response("<h1>Sandbox application</h1>", {
        headers: { "content-type": "text/html" },
      }),
  });
  appReturnOrigin = returnServer.url.origin;
  api = await startApi();
  standaloneApi = await startApi("");
});

test.afterAll(async () => {
  await api?.stop();
  await standaloneApi?.stop();
  await returnServer?.stop(true);
  runDatabaseAction("cleanup");
});

test.beforeEach(() => {
  runDatabaseAction("setup");
});

async function enterWithReturnTo(page: Page, returnTo: string): Promise<void> {
  const startUrl = new URL("/", api!.origin);
  startUrl.searchParams.set("return_to", returnTo);
  await page.goto(startUrl.href);
}

test("待合室へ直接アクセスすると認証や手動参加なしで設定済みアプリへ戻る", async ({
  page,
}) => {
  const authRequests: string[] = [];
  const waitingDocuments: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/auth/")) {
      authRequests.push(request.url());
    }
  });
  page.on("response", (response) => {
    if (
      response.request().isNavigationRequest() &&
      new URL(response.url()).origin === api!.origin &&
      response.status() === 200
    ) {
      waitingDocuments.push(response.url());
    }
  });
  await page.goto(`${api!.origin}/`);
  await expect(page).toHaveURL(`${appReturnOrigin}/`);
  await expect(
    page.getByRole("heading", { name: "Sandbox application" }),
  ).toBeVisible();
  expect(authRequests).toEqual([]);
  expect(waitingDocuments).toEqual([]);
  const queue = await page.context().request.get(`${api!.origin}/queue`);
  expect(await queue.json()).toMatchObject({ status: "admitted" });
});

test("満席の直接アクセスは待機だけを表示し、枠が空くと設定済みアプリへ自動復帰する", async ({
  page,
}) => {
  const origin = api!.origin;
  const occupant = runDatabaseAction("seed");
  const headers = { cookie: `vwr_session=${occupant}`, origin };
  await page.context().request.post(`${origin}/queue`, { headers });
  await page.clock.install();
  await page.goto(`${origin}/`);
  await expect(page.locator("#status")).toHaveText("前に 0 人が待っています。");
  await expect(page.locator("#login")).toBeHidden();
  await expect(page.locator("#join")).toBeHidden();
  await expect(page.locator("#protected-link")).toBeHidden();
  await expect(page.locator("#leave")).toBeHidden();
  await page.context().request.delete(`${origin}/queue`, { headers });
  await page.clock.fastForward(10_000);
  await expect(page).toHaveURL(`${appReturnOrigin}/`);
  await expect(
    page.getByRole("heading", { name: "Sandbox application" }),
  ).toBeVisible();
});

test("空き枠があれば匿名で入場し、待機画面や認証を経ず sandbox_app の元 URL へ戻る", async ({
  page,
}) => {
  const returnTo = `${appReturnOrigin}/orders/42?tab=detail#payment`;
  const waitingRoomDocuments: string[] = [];
  const authRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/auth/")) {
      authRequests.push(url.href);
    }
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (
      response.request().isNavigationRequest() &&
      url.origin === api!.origin &&
      response.status() === 200
    ) {
      waitingRoomDocuments.push(url.href);
    }
  });

  await enterWithReturnTo(page, returnTo);

  await expect(page).toHaveURL(returnTo);
  await expect(
    page.getByRole("heading", { name: "Sandbox application" }),
  ).toBeVisible();
  expect(waitingRoomDocuments).toEqual([]);
  expect(authRequests).toEqual([]);
  const queue = await page.context().request.get(`${api!.origin}/queue`);
  expect(queue.status()).toBe(200);
  expect(await queue.json()).toMatchObject({ status: "admitted" });
});

test("満席なら自動で FIFO に並び、先行者の入場後に元の sandbox_app URL へ戻る", async ({
  browser,
  page,
}) => {
  const origin = api!.origin;
  const occupant = runDatabaseAction("seed");
  const predecessor = runDatabaseAction("seed");
  const request = page.context().request;
  const queueHeaders = (token: string) => ({
    cookie: `vwr_session=${token}`,
    origin,
  });
  await request.post(`${origin}/queue`, { headers: queueHeaders(occupant) });
  await request.post(`${origin}/queue`, { headers: queueHeaders(predecessor) });
  const returnTo = `${appReturnOrigin}/checkout?cart=42#confirm`;
  const visitor = await browser.newContext();
  const waitingPage = await visitor.newPage();

  try {
    await enterWithReturnTo(waitingPage, returnTo);
    await expect
      .poll(async () => {
        const response = await visitor.request.get(`${origin}/queue`);
        return { status: response.status(), body: await response.json() };
      })
      .toMatchObject({ status: 200, body: { status: "waiting", ahead: 1 } });
    expect(new URL(waitingPage.url()).origin).toBe(origin);
    await expect(
      waitingPage.getByRole("button", { name: "並ぶ", exact: true }),
    ).toBeHidden();
    await expect(waitingPage.locator("#leave")).toBeHidden();

    await request.delete(`${origin}/queue`, {
      headers: queueHeaders(occupant),
    });
    await expect
      .poll(async () => {
        const response = await request.get(`${origin}/queue`, {
          headers: queueHeaders(predecessor),
        });
        return response.json();
      })
      .toMatchObject({ status: "admitted" });
    const stillWaiting = await visitor.request.get(`${origin}/queue`);
    expect(await stillWaiting.json()).toMatchObject({ status: "waiting" });
    expect(new URL(waitingPage.url()).origin).toBe(origin);

    await request.delete(`${origin}/queue`, {
      headers: queueHeaders(predecessor),
    });
    await expect(waitingPage).toHaveURL(returnTo, { timeout: 15_000 });
    await expect(
      waitingPage.getByRole("heading", { name: "Sandbox application" }),
    ).toBeVisible();
  } finally {
    await visitor.close();
  }
});

test("匿名の待機期限が切れても手動操作なしで同じsessionで再参加し、入場後に戻る", async ({
  page,
}) => {
  const origin = api!.origin;
  const occupant = runDatabaseAction("seed");
  const headers = { cookie: `vwr_session=${occupant}`, origin };
  await page.context().request.post(`${origin}/queue`, { headers });
  await page.clock.install();
  const firstPoll = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/queue" &&
      response.request().method() === "GET",
  );
  const returnTo = `${appReturnOrigin}/resume?cart=42#checkout`;
  await enterWithReturnTo(page, returnTo);
  await firstPoll;
  const token = (await page.context().cookies(origin)).find(
    (cookie) => cookie.name === "vwr_session",
  )?.value;
  expect(token).toBeTruthy();
  runDatabaseAction("expire-waiting", token!);
  const reentryLoaded = page.waitForEvent("domcontentloaded", {
    timeout: 5_000,
  });
  const reentry = page.waitForRequest(
    (request) =>
      request.isNavigationRequest() &&
      new URL(request.url()).origin === origin &&
      new URL(request.url()).searchParams.get("return_to") === returnTo,
    { timeout: 5_000 },
  );
  await page.clock.fastForward(10_000);
  await reentry;
  await reentryLoaded;
  await expect(page.locator("#status")).toHaveText("前に 0 人が待っています。");
  await expect(
    page.getByRole("button", { name: "並ぶ", exact: true }),
  ).toBeHidden();
  await expect
    .poll(async () => {
      const response = await page.context().request.get(`${origin}/queue`);
      return response.json();
    })
    .toMatchObject({ status: "waiting", ahead: 0 });
  expect(
    (await page.context().cookies(origin)).find(
      (cookie) => cookie.name === "vwr_session",
    )?.value,
  ).toBe(token);
  await page.context().request.delete(`${origin}/queue`, { headers });
  await page.clock.fastForward(10_000);
  await expect(page).toHaveURL(returnTo);
});

async function joinAsAdmitted(page: Page, origin: string): Promise<void> {
  await page.goto(`${origin}/`);
  const joinResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/queue" &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "並ぶ" }).click();
  const joined = await joinResponse;

  expect(joined.status()).toBe(200);
  expect(await joined.json()).toMatchObject({ status: "admitted" });
  await expect(page.locator('a[href="/protected"]')).toBeVisible();
}

async function hiddenTextContent(page: Page): Promise<string[]> {
  return page.locator("body").evaluate((body) => {
    const hiddenTexts: string[] = [];
    const leaves = Array.from(body.querySelectorAll("body *")).filter(
      (element) =>
        element.children.length === 0 &&
        !["SCRIPT", "STYLE", "NOSCRIPT"].includes(element.tagName),
    );

    for (const element of leaves) {
      const text = element.textContent?.trim();

      if (!text) {
        continue;
      }

      let current: Element | null = element;
      let hidden = false;

      while (current && current !== body) {
        const style = getComputedStyle(current);

        if (
          current.hasAttribute("hidden") ||
          current.getAttribute("aria-hidden") === "true" ||
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.opacity === "0"
        ) {
          hidden = true;
          break;
        }

        current = current.parentElement;
      }

      if (hidden && !hiddenTexts.includes(text)) {
        hiddenTexts.push(text);
      }
    }

    return hiddenTexts;
  });
}

test("join 後の初回 renew と継続 heartbeat を確認し、409 で保護表示を隠して再受付へ戻る", async ({
  browser,
}) => {
  const server = standaloneApi;

  if (!server) {
    throw new Error("The API process did not start");
  }

  const token = runDatabaseAction("seed");
  const context = await browser.newContext();
  await context.addCookies([
    {
      name: "vwr_session",
      value: token,
      url: server.origin,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);

  const page = await context.newPage();
  await page.clock.install();
  let renewCount = 0;
  let firstRenewCaptured = false;
  let firstRenewStatus = 0;
  let releaseFirstRenew = (): void => {};
  let releaseSecondRenew = (): void => {};
  let resolveFirstRenew: () => void = () => {};
  let resolveSecondRenew: () => void = () => {};
  const firstRenewStarted = new Promise<void>((resolve) => {
    resolveFirstRenew = resolve;
  });
  const secondRenewStarted = new Promise<void>((resolve) => {
    resolveSecondRenew = resolve;
  });
  const firstRenewGate = new Promise<void>((resolve) => {
    releaseFirstRenew = resolve;
  });
  const secondRenewGate = new Promise<void>((resolve) => {
    releaseSecondRenew = resolve;
  });

  await page.route("**/queue/renew", async (route) => {
    renewCount += 1;

    if (!firstRenewCaptured) {
      firstRenewCaptured = true;
      const response = await route.fetch();
      firstRenewStatus = response.status();
      resolveFirstRenew();
      await firstRenewGate;
      await route.fulfill({ response });
      return;
    }

    if (renewCount === 2) {
      resolveSecondRenew();
      await secondRenewGate;
    }

    await route.continue();
  });

  try {
    await joinAsAdmitted(page, server.origin);

    await page.goto(`${server.origin}/protected`, {
      waitUntil: "domcontentloaded",
    });
    await firstRenewStarted;
    const hiddenProtectedText = await hiddenTextContent(page);

    expect(firstRenewStatus).toBe(200);
    const textBeforeRenewal = await page.locator("body").innerText();
    for (const text of hiddenProtectedText) {
      expect(textBeforeRenewal).not.toContain(text);
    }

    releaseFirstRenew();
    await expect
      .poll(
        async () => {
          const visibleText = await page.locator("body").innerText();
          return hiddenProtectedText.find((text) => visibleText.includes(text));
        },
        { timeout: 5_000 },
      )
      .toBeTruthy();

    const protectedText = await page.locator("body").innerText();
    const newlyVisibleText = protectedText
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !textBeforeRenewal.includes(line));
    const protectedOnlyText =
      hiddenProtectedText.find((text) => protectedText.includes(text)) ??
      newlyVisibleText;
    expect(protectedOnlyText).toBeTruthy();

    await page.clock.fastForward(30_000);
    await secondRenewStarted;

    const secondTab = await context.newPage();
    await secondTab.goto(`${server.origin}/`);
    const leaveStatus = await secondTab.evaluate(async () => {
      const response = await fetch("/queue", { method: "DELETE" });
      return response.status;
    });
    expect(leaveStatus).toBe(204);

    const rejectedRenew = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/queue/renew" &&
        response.status() === 409,
      { timeout: 40_000 },
    );
    releaseSecondRenew();
    await rejectedRenew;
    await page.waitForURL((url) => url.pathname === "/", {
      timeout: 5_000,
    });

    const returnedText = await page.locator("body").innerText();
    expect(returnedText).not.toContain(protectedOnlyText!);

    const queueState = await page.evaluate(async () => {
      const response = await fetch("/queue");
      return { status: response.status, body: await response.json() };
    });
    expect(queueState).toEqual({
      status: 409,
      body: { code: "QUEUE_NOT_JOINED" },
    });
    await expect(page.getByRole("button", { name: "並ぶ" })).toBeVisible();
  } finally {
    releaseFirstRenew();
    releaseSecondRenew();
    await context.close();
  }
});

test("保護画面の初回 renew を再試行で回復すると次の heartbeat も送る", async ({
  browser,
}) => {
  const server = standaloneApi;

  if (!server) {
    throw new Error("The API process did not start");
  }

  const token = runDatabaseAction("seed");
  const context = await browser.newContext();
  await context.addCookies([
    {
      name: "vwr_session",
      value: token,
      url: server.origin,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);

  const page = await context.newPage();
  await page.clock.install();
  let renewCount = 0;

  await page.route("**/queue/renew", async (route) => {
    renewCount += 1;

    if (renewCount === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ code: "UNAVAILABLE" }),
      });
      return;
    }

    await route.continue();
  });

  try {
    await joinAsAdmitted(page, server.origin);

    const firstRenew = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/queue/renew" &&
        response.status() === 503,
    );
    await page.goto(`${server.origin}/protected`, {
      waitUntil: "domcontentloaded",
    });
    await firstRenew;

    const hiddenProtectedText = await hiddenTextContent(page);
    expect(hiddenProtectedText.length).toBeGreaterThan(0);
    const textBeforeRetry = await page.locator("body").innerText();
    for (const text of hiddenProtectedText) {
      expect(textBeforeRetry).not.toContain(text);
    }
    const retryButton = page.getByRole("button", { name: /再試行/ });
    await expect(retryButton).toBeVisible();

    const retryRenew = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/queue/renew" &&
        response.status() === 200,
    );
    await retryButton.click();
    await retryRenew;
    await expect
      .poll(async () => {
        const text = await page.locator("body").innerText();
        return hiddenProtectedText.find((protectedText) =>
          text.includes(protectedText),
        );
      })
      .toBeTruthy();

    const nextHeartbeat = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/queue/renew" &&
        response.status() === 200,
      { timeout: 5_000 },
    );
    await page.clock.fastForward(30_000);
    await nextHeartbeat;
    expect(renewCount).toBe(3);
  } finally {
    await context.close();
  }
});

test("待合室の入場済み画面は heartbeat を続け、renew 401/409/503 で保護リンクを隠す", async ({
  browser,
}) => {
  const server = standaloneApi;

  if (!server) {
    throw new Error("The API process did not start");
  }

  const failures = [
    { status: 401, code: "AUTH_REQUIRED" },
    { status: 409, code: "NOT_ADMITTED" },
    { status: 503, code: "UNAVAILABLE" },
  ];

  for (const failure of failures) {
    runDatabaseAction("setup");
    const token = runDatabaseAction("seed");
    const context = await browser.newContext();
    await context.addCookies([
      {
        name: "vwr_session",
        value: token,
        url: server.origin,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);

    const page = await context.newPage();
    await page.clock.install();
    await page.route("**/queue/renew", (route) =>
      route.fulfill({
        status: failure.status,
        contentType: "application/json",
        body: JSON.stringify({ code: failure.code }),
      }),
    );

    try {
      await joinAsAdmitted(page, server.origin);
      const renewResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/queue/renew" &&
          response.status() === failure.status,
        { timeout: 5_000 },
      );
      await page.clock.fastForward(30_000);
      const response = await renewResponse;

      expect(response.status()).toBe(failure.status);
      await expect(page.locator('a[href="/protected"]')).toBeHidden();
    } finally {
      await context.close();
    }
  }
});

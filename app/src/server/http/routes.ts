// Hono route と middleware を組み立て、HTTP request を OIDC・queue 処理へ渡す
import { Hono } from "hono";
import { OidcFlowError } from "../auth/oidc.ts";
import type { OidcClient } from "../auth/oidc.ts";
import {
  StoreUnavailableError,
  WaitingRoomError,
} from "../waiting-room/errors.ts";
import type { WaitingRoomService } from "../waiting-room/service.ts";
import type { ClientAssets } from "./client-assets.ts";
import {
  htmlResponse,
  jsonResponse,
  redirectResponse,
  responseHeaders,
} from "./responses.ts";

const QUEUE_REQUEST_TIMEOUT_MS = 10_000;
const AUTH_REQUEST_TIMEOUT_MS = 40_000;
const SESSION_COOKIE = "vwr_session";
const OIDC_COOKIE = "vwr_oidc";

interface Application {
  appOrigin: string;
  appReturnOrigin: string | undefined;
  sessionCookieDomain: string | undefined;
  secureCookies: boolean;
  waitingRoom: WaitingRoomService;
  oidc: OidcClient;
  assets: ClientAssets;
}

/** request abort と route 固有の期限のうち、先に発生した signal を返す */
function requestSignal(request: Request, timeoutMs: number): AbortSignal {
  return AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]);
}

/** Cookie 名が重複する request を拒否し、指定 cookie の値だけを取り出す */
function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");

  if (!header) {
    return null;
  }

  const matches = header
    .split(";")
    .map((item) => item.trim())
    .filter((item) => item.startsWith(`${name}=`));

  if (matches.length !== 1) {
    return null;
  }

  return matches[0]?.slice(name.length + 1) ?? null;
}

/** session cookie に HttpOnly/SameSite を付け、HTTPS では Secure も付ける */
function cookieHeader(
  name: string,
  value: string,
  maxAge: number,
  secure: boolean,
  domain?: string,
): string {
  const attributes = [
    `${name}=${value}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAge}`,
  ];

  if (secure) {
    attributes.push("Secure");
  }
  if (domain) {
    attributes.push(`Domain=${domain}`);
  }

  return attributes.join("; ");
}

function expiredCookieHeader(
  name: string,
  secure: boolean,
  domain?: string,
): string {
  return cookieHeader(name, "", 0, secure, domain);
}

/** 復帰先を許可済みの公開 origin と照合する */
function validateReturnTo(value: string, application: Application): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OidcFlowError(400, "AUTH_FAILED");
  }
  if (
    !application.appReturnOrigin ||
    url.origin !== application.appReturnOrigin ||
    url.username ||
    url.password ||
    /[\s\\]/.test(value)
  ) {
    throw new OidcFlowError(400, "AUTH_FAILED");
  }
  return url.href;
}

function readReturnTo(url: URL, application: Application): string | null {
  const values = url.searchParams.getAll("return_to");
  if (values.length === 0) {
    return null;
  }
  if (values.length !== 1) {
    throw new OidcFlowError(400, "AUTH_FAILED");
  }
  return validateReturnTo(values[0] ?? "", application);
}

/** 内部 error を公開情報を絞った JSON/HTML 応答へ変換する */
function errorResponse(error: unknown, html = false): Response {
  let status = 500;
  let code = "INTERNAL_ERROR";
  let retryable = false;

  if (error instanceof WaitingRoomError || error instanceof OidcFlowError) {
    status = error.status;
    code = error.code;
    retryable = status === 503;
  } else if (error instanceof StoreUnavailableError) {
    status = 503;
    code = "UNAVAILABLE";
    retryable = true;
  } else if (error instanceof DOMException && error.name === "TimeoutError") {
    status = 503;
    code = "UNAVAILABLE";
    retryable = true;
  }

  if (html) {
    return htmlResponse(
      `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>仮想待合室</title></head><body><main><h1>アクセスできません</h1><p>${code}</p><a href="/">待合室へ戻る</a></main></body></html>`,
      status,
      retryable,
    );
  }

  return jsonResponse({ code }, status, retryable);
}

/** state-changing API の cross-site request を拒否するため Origin を照合する */
function sameOriginRequest(request: Request, appOrigin: string): boolean {
  return request.headers.get("origin") === appOrigin;
}

/** 入場判定後に返す保護画面の shell を作る */
function protectedHtml(scriptPath: string, stylePath: string | null): string {
  const stylesheet = stylePath
    ? `<link rel="stylesheet" href="${stylePath}">`
    : "";

  return `<!doctype html>
<html lang="ja" data-page="protected">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>保護画面 | 仮想待合室</title>
    ${stylesheet}
  </head>
  <body data-page="protected">
    <main id="app" class="page page-protected">
      <h1>保護画面</h1>
      <p id="protected-status" role="status">入場状態を確認しています。</p>
      <section id="protected-content" hidden>
        <h2>入場できました</h2>
        <p>この内容は有効な入場枠がある間だけ表示されます。</p>
      </section>
    </main>
    <script type="module" src="${scriptPath}"></script>
  </body>
</html>`;
}

function addCookie(response: Response, cookie: string): Response {
  response.headers.append("set-cookie", cookie);
  return response;
}

/** session が無効なら、その cookie を削除する header を追加する */
function clearSessionCookieAfterAuthFailure(
  response: Response,
  error: unknown,
  application: Application,
): Response {
  if (
    error instanceof WaitingRoomError &&
    error.status === 401 &&
    error.code === "AUTH_REQUIRED"
  ) {
    return addCookie(
      response,
      expiredCookieHeader(
        SESSION_COOKIE,
        application.secureCookies,
        application.sessionCookieDomain,
      ),
    );
  }

  return response;
}

/** OIDC callback を検証し、成功時だけ session cookie を発行して待合へ戻す */
async function handleCallback(
  request: Request,
  url: URL,
  application: Application,
): Promise<Response> {
  const signal = requestSignal(request, AUTH_REQUEST_TIMEOUT_MS);

  try {
    const completed = await application.oidc.completeAuth(
      url,
      readCookie(request, OIDC_COOKIE),
      signal,
    );
    const response = redirectResponse(new URL("/", application.appOrigin).href);
    addCookie(
      response,
      cookieHeader(
        SESSION_COOKIE,
        completed.sessionToken,
        completed.sessionExpiresIn,
        application.secureCookies,
        application.sessionCookieDomain,
      ),
    );
    addCookie(
      response,
      expiredCookieHeader(OIDC_COOKIE, application.secureCookies),
    );
    return response;
  } catch (error) {
    return addCookie(
      errorResponse(error),
      expiredCookieHeader(OIDC_COOKIE, application.secureCookies),
    );
  }
}

type QueueAction = "join" | "poll" | "leave" | "renew";

/** cookie の session token を使い、指定された queue 操作を実行する */
async function handleQueueAction(
  request: Request,
  application: Application,
  action: QueueAction,
): Promise<Response> {
  const token = readCookie(request, SESSION_COOKIE) ?? "";
  const signal = requestSignal(request, QUEUE_REQUEST_TIMEOUT_MS);

  try {
    switch (action) {
      case "join":
        return jsonResponse(await application.waitingRoom.join(token, signal));
      case "poll":
        return jsonResponse(await application.waitingRoom.poll(token, signal));
      case "leave":
        await application.waitingRoom.leave(token, signal);
        return new Response(null, {
          status: 204,
          headers: responseHeaders("text/plain; charset=utf-8"),
        });
      case "renew":
        return jsonResponse(await application.waitingRoom.renew(token, signal));
    }
  } catch (error) {
    return clearSessionCookieAfterAuthFailure(
      errorResponse(error),
      error,
      application,
    );
  }
}

/** origin/method を確認してから、画面・認証・queue・保護 route を登録する */
export function createHttpApp(application: Application): Hono {
  const router = new Hono();

  // route dispatch 前に Origin、許可 method、HEAD の扱いを共通検証する
  router.use("*", async (context, next) => {
    const { method, path } = context.req;
    const isQueuePath = path === "/queue" || path === "/queue/renew";

    // route を呼ぶ前に Origin を確認し、cross-site request で queue 状態を変更させない
    if (
      isQueuePath &&
      method !== "GET" &&
      !sameOriginRequest(context.req.raw, application.appOrigin)
    ) {
      return jsonResponse({ code: "ORIGIN_INVALID" }, 403);
    }

    if (
      (path === "/queue" &&
        method !== "GET" &&
        method !== "POST" &&
        method !== "DELETE") ||
      (path === "/queue/renew" && method !== "POST")
    ) {
      return jsonResponse({ code: "METHOD_NOT_ALLOWED" }, 405);
    }

    if (path === "/protected" && method !== "GET") {
      return htmlResponse(
        '<!doctype html><html lang="ja"><body><p>METHOD_NOT_ALLOWED</p></body></html>',
        405,
      );
    }

    // HEAD を GET と同じ扱いにせず、protected route の確認を迂回させない
    if (method === "HEAD") {
      return jsonResponse({ code: "NOT_FOUND" }, 404);
    }

    await next();
  });

  // route 内の例外と未登録 path を共通の公開 error 形式へ変換する
  router.onError((error, context) =>
    errorResponse(error, context.req.path === "/protected"),
  );
  router.notFound(() => jsonResponse({ code: "NOT_FOUND" }, 404));

  // 認証開始と callback は OIDC client に state・nonce・PKCE の検証を委ねる
  router.get("/", async (context) => {
    const returnTo = readReturnTo(new URL(context.req.url), application);
    if (!returnTo) {
      if (application.appReturnOrigin) {
        const entry = new URL("/", application.appOrigin);
        entry.searchParams.set(
          "return_to",
          new URL("/", application.appReturnOrigin).href,
        );
        return redirectResponse(entry.href);
      }
      return htmlResponse(application.assets.indexHtml);
    }
    const entered = await application.waitingRoom.enter(
      readCookie(context.req.raw, SESSION_COOKIE),
      requestSignal(context.req.raw, QUEUE_REQUEST_TIMEOUT_MS),
    );
    const response =
      entered.state.status === "admitted"
        ? redirectResponse(returnTo)
        : htmlResponse(application.assets.indexHtml);
    if (entered.sessionToken) {
      addCookie(
        response,
        cookieHeader(
          SESSION_COOKIE,
          entered.sessionToken,
          entered.sessionExpiresIn,
          application.secureCookies,
          application.sessionCookieDomain,
        ),
      );
    }
    return response;
  });
  router.get("/auth/start", async (context) => {
    try {
      if (new URL(context.req.url).searchParams.has("return_to")) {
        throw new OidcFlowError(400, "AUTH_FAILED");
      }
      const started = await application.oidc.startAuth(
        requestSignal(context.req.raw, AUTH_REQUEST_TIMEOUT_MS),
      );
      return addCookie(
        redirectResponse(started.redirectUrl.href),
        cookieHeader(
          OIDC_COOKIE,
          started.transactionCookie,
          300,
          application.secureCookies,
        ),
      );
    } catch (error) {
      return errorResponse(error);
    }
  });
  router.get("/auth/callback", (context) =>
    handleCallback(context.req.raw, new URL(context.req.url), application),
  );
  router.get("/queue", (context) =>
    handleQueueAction(context.req.raw, application, "poll"),
  );
  router.post("/queue", (context) =>
    handleQueueAction(context.req.raw, application, "join"),
  );
  router.delete("/queue", (context) =>
    handleQueueAction(context.req.raw, application, "leave"),
  );
  router.post("/queue/renew", (context) =>
    handleQueueAction(context.req.raw, application, "renew"),
  );
  // 保護 HTML は cookie の入場枠を DB で確認した request にだけ返す
  router.get("/protected", async (context) => {
    try {
      const authorized = await application.waitingRoom.authorize(
        readCookie(context.req.raw, SESSION_COOKIE) ?? "",
        requestSignal(context.req.raw, QUEUE_REQUEST_TIMEOUT_MS),
      );

      if (!authorized) {
        throw new WaitingRoomError(403, "ADMISSION_REQUIRED");
      }

      return htmlResponse(
        protectedHtml(
          application.assets.scriptPath,
          application.assets.stylePath,
        ),
      );
    } catch (error) {
      return clearSessionCookieAfterAuthFailure(
        errorResponse(error, true),
        error,
        application,
      );
    }
  });
  // build 済み資産 map にある path だけを返し、filesystem は参照しない
  router.get("*", (context) => {
    const asset = application.assets.files.get(context.req.path);

    if (!asset) {
      return jsonResponse({ code: "NOT_FOUND" }, 404);
    }

    const headers = new Headers({
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    });
    return new Response(asset, { headers });
  });

  return router;
}

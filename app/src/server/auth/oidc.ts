// sandbox-auth の OIDC Code Flow と待合 session 発行を担当する
import { randomBytes } from "node:crypto";
import * as oidc from "openid-client";
import { PostgresWaitingRoomStore } from "../waiting-room/store.ts";

const OIDC_REQUEST_TIMEOUT_SECONDS = 8;
const OIDC_REQUEST_TIMEOUT_MS = OIDC_REQUEST_TIMEOUT_SECONDS * 1_000;
const AUTH_SESSION_LIFETIME_SECONDS = 3_600;

export interface OidcSettings {
  appOrigin: string;
  issuerUrl: string;
  internalUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  allowInsecureLoopback: boolean;
}

export interface OidcStartResult {
  redirectUrl: URL;
  transactionCookie: string;
}

export interface OidcCompleteResult {
  subject: string;
  sessionToken: string;
  sessionExpiresIn: number;
}

export class OidcFlowError extends Error {
  constructor(
    readonly status: 400 | 503,
    readonly code: "AUTH_FAILED" | "UNAVAILABLE",
    cause?: unknown,
  ) {
    super(code, { cause });
    this.name = "OidcFlowError";
  }
}

function isLoopbackUrl(url: URL): boolean {
  return url.hostname === "127.0.0.1" || url.hostname === "localhost";
}

/** callback の固定 path、HTTPS、client 情報、loopback の例外条件を検証する */
function assertOidcSettings(settings: OidcSettings): void {
  const appOrigin = new URL(settings.appOrigin);
  const issuer = new URL(settings.issuerUrl);
  const internal = new URL(settings.internalUrl);
  const redirect = new URL(settings.redirectUri);
  const expectedRedirect = new URL("/auth/callback", appOrigin);
  const appIsLoopback = isLoopbackUrl(appOrigin);
  const issuerIsLoopback = isLoopbackUrl(issuer);
  const internalIsLoopback = isLoopbackUrl(internal);
  const internalIsClusterService =
    internal.hostname.endsWith(".svc.cluster.local");
  const internalSharesIssuerOrigin = internal.origin === issuer.origin;
  const internalProtocolIsAllowed =
    (internal.protocol === "https:" &&
      (internalSharesIssuerOrigin || internalIsClusterService)) ||
    (internal.protocol === "http:" &&
      (internalIsClusterService ||
        (settings.allowInsecureLoopback && internalIsLoopback)));

  if (
    appOrigin.origin !== settings.appOrigin ||
    appOrigin.pathname !== "/" ||
    appOrigin.search ||
    appOrigin.hash ||
    issuer.search ||
    issuer.hash ||
    issuer.username ||
    issuer.password ||
    !internalProtocolIsAllowed ||
    internal.search ||
    internal.hash ||
    internal.username ||
    internal.password ||
    redirect.href !== expectedRedirect.href ||
    !settings.clientId ||
    !settings.clientSecret ||
    (appOrigin.protocol !== "https:" && !appIsLoopback) ||
    (issuer.protocol !== "https:" &&
      !(settings.allowInsecureLoopback && issuerIsLoopback)) ||
    (settings.allowInsecureLoopback && (!appIsLoopback || !issuerIsLoopback))
  ) {
    throw new TypeError("OIDC configuration is invalid");
  }
}

function isTimeoutError(error: unknown, depth = 0): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (
    error.name === "TimeoutError" ||
    error.name === "AbortError" ||
    ("code" in error && error.code === "OAUTH_TIMEOUT")
  ) {
    return true;
  }

  if (depth >= 5 || !("cause" in error)) {
    return false;
  }

  return isTimeoutError(error.cause, depth + 1);
}

/** transport/library error を認証失敗か retry 可能な障害へ分類する */
function safeOidcError(error: unknown): OidcFlowError {
  if (error instanceof OidcFlowError) {
    return error;
  }

  if (isTimeoutError(error)) {
    return new OidcFlowError(503, "UNAVAILABLE", error);
  }

  if (error instanceof oidc.ClientError) {
    return new OidcFlowError(400, "AUTH_FAILED", error);
  }

  if (
    error instanceof oidc.ResponseBodyError &&
    [
      "access_denied",
      "invalid_grant",
      "invalid_request",
      "invalid_token",
    ].includes(error.error)
  ) {
    return new OidcFlowError(400, "AUTH_FAILED", error);
  }

  return new OidcFlowError(503, "UNAVAILABLE", error);
}

/** OIDC Discovery と token request を上限付きで実行する */
function mapIssuerUrlToInternal(
  input: string,
  issuer: URL,
  internal: URL,
): string {
  const requestUrl = new URL(input);
  const issuerPath = issuer.pathname.replace(/\/+$/, "");
  const requestIsUnderIssuer =
    issuerPath === "" ||
    requestUrl.pathname === issuerPath ||
    requestUrl.pathname.startsWith(`${issuerPath}/`);

  if (requestUrl.origin !== issuer.origin || !requestIsUnderIssuer) {
    return input;
  }

  const internalUrl = new URL(internal.href);
  const internalPath = internalUrl.pathname.replace(/\/+$/, "");
  const requestPath = requestUrl.pathname.slice(issuerPath.length);
  internalUrl.pathname = `${internalPath}${requestPath}`;
  internalUrl.search = requestUrl.search;
  internalUrl.hash = requestUrl.hash;

  return internalUrl.href;
}

function createBoundedFetch(
  issuerUrl: string,
  internalUrl: string,
): (input: string, options: oidc.CustomFetchOptions) => Promise<Response> {
  const issuer = new URL(issuerUrl);
  const internal = new URL(internalUrl);

  return (input, options) => {
    const timeout = AbortSignal.timeout(OIDC_REQUEST_TIMEOUT_MS);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout;

    // issuer URL は維持し、同じ origin の server-side 通信だけ内部 URL へ振り替える
    return fetch(mapIssuerUrlToInternal(input, issuer, internal), {
      ...options,
      body: options.body as unknown as RequestInit["body"],
      signal,
    });
  };
}

/** transaction を一回限りで保存し、認証後に待合 session を発行する */
export class OidcClient {
  readonly #settings: OidcSettings;
  readonly #store: PostgresWaitingRoomStore;
  #configuration: Promise<oidc.Configuration> | undefined;

  constructor(settings: OidcSettings, store: PostgresWaitingRoomStore) {
    assertOidcSettings(settings);
    this.#settings = settings;
    this.#store = store;
  }

  /** 認可 URL を作り、callback 検証用の state/nonce/PKCE を保存する */
  async startAuth(signal: AbortSignal): Promise<OidcStartResult> {
    try {
      const configuration = await this.#getConfiguration();
      // 認可要求と callback の照合に使う値を一組で生成する
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const codeVerifier = oidc.randomPKCECodeVerifier();
      const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
      const transactionCookie = randomBytes(32).toString("base64url");
      const redirectUrl = oidc.buildAuthorizationUrl(configuration, {
        redirect_uri: this.#settings.redirectUri,
        scope: "openid",
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      });

      // transaction cookie を手掛かりに、callback の照合情報を期限付きで保存する
      await this.#store.createOidcTransaction(
        transactionCookie,
        state,
        nonce,
        codeVerifier,
        signal,
      );

      return { redirectUrl, transactionCookie };
    } catch (error) {
      throw safeOidcError(error);
    }
  }

  /** callback を検証して transaction を消費し、claim 検証後に session を発行する */
  async completeAuth(
    callbackUrl: URL,
    transactionCookie: string | null,
    signal: AbortSignal,
  ): Promise<OidcCompleteResult> {
    const stateValues = callbackUrl.searchParams.getAll("state");
    const codeValues = callbackUrl.searchParams.getAll("code");
    const expectedRedirect = new URL(this.#settings.redirectUri);

    if (
      callbackUrl.origin !== expectedRedirect.origin ||
      callbackUrl.pathname !== expectedRedirect.pathname ||
      callbackUrl.hash ||
      stateValues.length !== 1 ||
      codeValues.length !== 1 ||
      !transactionCookie
    ) {
      throw new OidcFlowError(400, "AUTH_FAILED");
    }

    const state = stateValues[0];

    if (!state) {
      throw new OidcFlowError(400, "AUTH_FAILED");
    }

    const transaction = await this.#store.consumeOidcTransaction(
      transactionCookie,
      state,
      signal,
    );

    // token request より先に消費し、失敗後の callback 再送でも同じ transaction を使わせない
    if (!transaction) {
      throw new OidcFlowError(400, "AUTH_FAILED");
    }

    try {
      const configuration = await this.#getConfiguration();
      const tokens = await oidc.authorizationCodeGrant(
        configuration,
        callbackUrl,
        {
          expectedState: state,
          expectedNonce: transaction.nonce,
          pkceCodeVerifier: transaction.pkceVerifier,
        },
        { redirect_uri: this.#settings.redirectUri },
      );
      const claims = tokens.claims();
      const subject = claims?.sub;
      const expiresAt = claims?.exp;

      if (
        typeof subject !== "string" ||
        subject.length === 0 ||
        typeof expiresAt !== "number" ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= Date.now() / 1_000
      ) {
        throw new OidcFlowError(400, "AUTH_FAILED");
      }

      // ID token の subject と有効期限を確認し、待合用 session を発行する
      const sessionToken = randomBytes(32).toString("base64url");
      await this.#store.createAuthenticatedSession(
        sessionToken,
        subject,
        signal,
      );

      return {
        subject,
        sessionToken,
        sessionExpiresIn: AUTH_SESSION_LIFETIME_SECONDS,
      };
    } catch (error) {
      throw safeOidcError(error);
    }
  }

  /** issuer metadata を遅延取得し、成功した configuration を再利用する */
  async #getConfiguration(): Promise<oidc.Configuration> {
    // Discovery 中の Promise を共有し、失敗時は下で破棄して次の request から再試行する
    if (!this.#configuration) {
      const issuer = new URL(this.#settings.issuerUrl);
      const allowInsecure = this.#settings.allowInsecureLoopback;
      const execute = allowInsecure
        ? [oidc.allowInsecureRequests, oidc.enableNonRepudiationChecks]
        : [oidc.enableNonRepudiationChecks];

      this.#configuration = oidc
        .discovery(
          issuer,
          this.#settings.clientId,
          {
            client_secret: this.#settings.clientSecret,
            token_endpoint_auth_method: "client_secret_basic",
          },
          oidc.ClientSecretBasic(this.#settings.clientSecret),
          {
            execute,
            timeout: OIDC_REQUEST_TIMEOUT_SECONDS,
            [oidc.customFetch]: createBoundedFetch(
              this.#settings.issuerUrl,
              this.#settings.internalUrl,
            ),
          },
        )
        .catch((error: unknown) => {
          this.#configuration = undefined;
          throw safeOidcError(error);
        });
    }

    return this.#configuration;
  }
}

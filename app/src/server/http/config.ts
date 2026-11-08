// 環境変数を検証済みの server 設定へ変換し、不正値を起動前に拒否する
export interface ServerSettings {
  databaseUrl: string;
  waitingRoomCapacity: number;
  host: string;
  port: number;
  appOrigin: string;
  appReturnOrigin: string | undefined;
  sessionCookieDomain: string | undefined;
  oidcIssuerUrl: string;
  oidcInternalUrl: string;
  oidcClientId: string;
  oidcClientSecret: string;
  oidcRedirectUri: string;
  secureCookies: boolean;
  allowInsecureLoopback: boolean;
}

type Environment = Record<string, string | undefined>;

const MAX_WAITING_ROOM_CAPACITY = 2_147_483_647;

/** 必須値を trim し、未設定なら値を含めずに設定名だけを報告する */
function required(environment: Environment, name: string): string {
  const value = environment[name]?.trim();

  if (!value) {
    throw new TypeError(`${name} is required`);
  }

  return value;
}

function createDatabaseUrl(environment: Environment): string {
  // URL の各項目を URL API で設定し、認証情報に含まれる予約文字を符号化する
  const databaseHost = required(environment, "DATABASE_HOST");
  const databasePort = Number(required(environment, "DATABASE_PORT"));

  if (
    !Number.isInteger(databasePort) ||
    databasePort < 1 ||
    databasePort > 65_535
  ) {
    throw new TypeError("DATABASE_PORT must be an integer between 1 and 65535");
  }

  const databaseUrl = new URL("postgres://localhost");
  databaseUrl.hostname = databaseHost;
  databaseUrl.port = String(databasePort);
  databaseUrl.pathname = `/${encodeURIComponent(required(environment, "DATABASE_NAME"))}`;
  databaseUrl.username = required(environment, "DATABASE_USER");
  databaseUrl.password = required(environment, "DATABASE_PASSWORD");
  databaseUrl.searchParams.set(
    "sslmode",
    environment.DATABASE_SSLMODE?.trim() || "disable",
  );

  const applicationName = environment.DATABASE_APPLICATION_NAME?.trim();

  if (applicationName) {
    databaseUrl.searchParams.set("application_name", applicationName);
  }

  return databaseUrl.toString();
}

/** HTTP を許可できるローカル開発先かを判定する */
function isLoopback(url: URL): boolean {
  return url.hostname === "127.0.0.1" || url.hostname === "localhost";
}

function readReturnOrigin(environment: Environment): string | undefined {
  const value = environment.APP_RETURN_ORIGIN?.trim();
  if (!value) {
    return undefined;
  }

  const url = new URL(value);
  if (
    url.origin !== value ||
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && isLoopback(url)))
  ) {
    throw new TypeError("APP_RETURN_ORIGIN is invalid");
  }
  return value;
}

function readSessionCookieDomain(
  environment: Environment,
  appOrigin: URL,
  returnOrigin: string | undefined,
): string | undefined {
  const value = environment.SESSION_COOKIE_DOMAIN?.trim().toLowerCase();
  if (!value) {
    return undefined;
  }

  const domain = value.replace(/^\./, "");
  const matches = (hostname: string): boolean =>
    hostname === domain || hostname.endsWith(`.${domain}`);
  // HTTP loopback fixture では属性の出力だけを検証し、通常の開発では Domain を省略する
  const localFixture = appOrigin.protocol === "http:" && isLoopback(appOrigin);
  if (
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
      domain,
    ) ||
    domain.length > 253 ||
    !returnOrigin ||
    !matches(new URL(returnOrigin).hostname) ||
    (!localFixture && !matches(appOrigin.hostname))
  ) {
    throw new TypeError("SESSION_COOKIE_DOMAIN is invalid");
  }
  return value;
}

/** DB、公開 origin、OIDC issuer/callback、listen address を一括検証する */
export function readServerSettings(environment: Environment): ServerSettings {
  const databaseUrl = createDatabaseUrl(environment);
  const parsedDatabaseUrl = new URL(databaseUrl);
  const waitingRoomCapacity = Number(
    required(environment, "WAITING_ROOM_CAPACITY"),
  );

  if (
    !Number.isInteger(waitingRoomCapacity) ||
    waitingRoomCapacity < 1 ||
    waitingRoomCapacity > MAX_WAITING_ROOM_CAPACITY
  ) {
    throw new TypeError(
      `WAITING_ROOM_CAPACITY must be an integer between 1 and ${MAX_WAITING_ROOM_CAPACITY}`,
    );
  }

  const appOrigin = required(environment, "APP_ORIGIN");
  const parsedAppOrigin = new URL(appOrigin);
  const appReturnOrigin = readReturnOrigin(environment);
  const sessionCookieDomain = readSessionCookieDomain(
    environment,
    parsedAppOrigin,
    appReturnOrigin,
  );
  const oidcIssuerUrl = required(environment, "OIDC_ISSUER_URL");
  const parsedIssuer = new URL(oidcIssuerUrl);
  const oidcInternalUrl = required(environment, "OIDC_INTERNAL_URL");
  const parsedInternalUrl = new URL(oidcInternalUrl);
  const oidcClientId = required(environment, "OIDC_CLIENT_ID");
  const oidcClientSecret = required(environment, "OIDC_CLIENT_SECRET");
  const oidcRedirectUri = required(environment, "OIDC_REDIRECT_URI");
  const parsedRedirect = new URL(oidcRedirectUri);
  const expectedRedirect = new URL("/auth/callback", parsedAppOrigin);
  const appIsLoopback = isLoopback(parsedAppOrigin);
  const issuerIsLoopback = isLoopback(parsedIssuer);
  const internalIsLoopback = isLoopback(parsedInternalUrl);
  const internalIsClusterService =
    parsedInternalUrl.hostname.endsWith(".svc.cluster.local");
  const internalSharesIssuerOrigin =
    parsedInternalUrl.origin === parsedIssuer.origin;
  const allowInsecureLoopback = appIsLoopback && issuerIsLoopback;
  const internalProtocolIsAllowed =
    (parsedInternalUrl.protocol === "https:" &&
      (internalSharesIssuerOrigin || internalIsClusterService)) ||
    (parsedInternalUrl.protocol === "http:" &&
      (internalIsClusterService ||
        (allowInsecureLoopback && internalIsLoopback)));

  // origin と callback を完全一致させ、別の redirect 先を受け付けない
  if (
    !["postgres:", "postgresql:"].includes(parsedDatabaseUrl.protocol) ||
    parsedAppOrigin.origin !== appOrigin ||
    parsedAppOrigin.pathname !== "/" ||
    parsedAppOrigin.search ||
    parsedAppOrigin.hash ||
    parsedIssuer.search ||
    parsedIssuer.hash ||
    parsedIssuer.username ||
    parsedIssuer.password ||
    !internalProtocolIsAllowed ||
    parsedInternalUrl.search ||
    parsedInternalUrl.hash ||
    parsedInternalUrl.username ||
    parsedInternalUrl.password ||
    parsedRedirect.href !== expectedRedirect.href ||
    (!appIsLoopback && parsedAppOrigin.protocol !== "https:") ||
    (!issuerIsLoopback && parsedIssuer.protocol !== "https:")
  ) {
    throw new TypeError("Server configuration is invalid");
  }

  const host = environment.HOST?.trim() || "127.0.0.1";
  const portText = environment.PORT?.trim() || "3100";
  const port = Number(portText);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError("PORT must be an integer between 1 and 65535");
  }

  return {
    databaseUrl,
    waitingRoomCapacity,
    host,
    port,
    appOrigin,
    appReturnOrigin,
    sessionCookieDomain,
    oidcIssuerUrl,
    oidcInternalUrl,
    oidcClientId,
    oidcClientSecret,
    oidcRedirectUri,
    secureCookies: parsedAppOrigin.protocol === "https:",
    allowInsecureLoopback,
  };
}

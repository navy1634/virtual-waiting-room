import { expect, test } from "bun:test";
import { OidcClient, type OidcSettings } from "../src/server/auth/oidc.ts";
import { readServerSettings } from "../src/server/http/config.ts";
import { PostgresWaitingRoomStore } from "../src/server/waiting-room/store.ts";

// issuer へ接続せず、DB connection も開かずに設定検証を行う
const testSettings: OidcSettings = {
  appOrigin: "http://localhost:3100",
  issuerUrl: "https://auth.sandbox.navy1634.com/api",
  internalUrl: "https://auth.sandbox.navy1634.com/api",
  clientId: "test-client",
  clientSecret: "test-client-secret",
  redirectUri: "http://localhost:3100/auth/callback",
  allowInsecureLoopback: false,
};

function validServerEnvironment(): Record<string, string | undefined> {
  return {
    DATABASE_HOST: "127.0.0.1",
    DATABASE_PORT: "5433",
    DATABASE_NAME: "vwr_test",
    DATABASE_USER: "test",
    DATABASE_PASSWORD: "test",
    WAITING_ROOM_CAPACITY: "1",
    APP_ORIGIN: "http://localhost:3100",
    OIDC_ISSUER_URL: "https://issuer.example.test/api",
    OIDC_INTERNAL_URL: "https://issuer.example.test/api",
    OIDC_CLIENT_ID: "test-client",
    OIDC_CLIENT_SECRET: "test-client-secret",
    OIDC_REDIRECT_URI: "http://localhost:3100/auth/callback",
  };
}

async function expectSettingsAccepted(settings: OidcSettings): Promise<void> {
  const store = new PostgresWaitingRoomStore(
    "postgres://test:test@127.0.0.1:5433/vwr_test?sslmode=disable",
    1,
  );

  try {
    expect(() => new OidcClient(settings, store)).not.toThrow();
  } finally {
    await store.close();
  }
}

function validLinkedEnvironment(): Record<string, string | undefined> {
  return {
    ...validServerEnvironment(),
    APP_ORIGIN: "https://waiting-room.sandbox.navy1634.com",
    OIDC_REDIRECT_URI:
      "https://waiting-room.sandbox.navy1634.com/auth/callback",
    APP_RETURN_ORIGIN: "https://app.sandbox.navy1634.com",
    SESSION_COOKIE_DOMAIN: ".navy1634.com",
  };
}

async function expectSettingsRejected(settings: OidcSettings): Promise<void> {
  const store = new PostgresWaitingRoomStore(
    "postgres://test:test@127.0.0.1:5433/vwr_test?sslmode=disable",
    1,
  );

  try {
    expect(() => new OidcClient(settings, store)).toThrow(
      "OIDC configuration is invalid",
    );
  } finally {
    await store.close();
  }
}

test("localhost の待合室から HTTPS issuer と同一 origin の internal URL を使える", async () => {
  await expectSettingsAccepted(testSettings);
});

test("cluster 内部 service の HTTP URL を internal URL に使える", async () => {
  await expectSettingsAccepted({
    ...testSettings,
    internalUrl: "http://sandbox-auth.auth.svc.cluster.local/api",
  });
});

test("cluster 内部 service の HTTPS URL を internal URL に使える", async () => {
  await expectSettingsAccepted({
    ...testSettings,
    internalUrl: "https://sandbox-auth.auth.svc.cluster.local/api",
  });
});

test("loopback issuer と内部 HTTP service URL を分けて設定できる", async () => {
  await expectSettingsAccepted({
    ...testSettings,
    issuerUrl: "https://127.0.0.1:1/api",
    internalUrl: "http://127.0.0.1:8080/api",
    allowInsecureLoopback: true,
  });
});

test("server settings は OIDC_INTERNAL_URL が設定されていれば受け付ける", () => {
  expect(() => readServerSettings(validServerEnvironment())).not.toThrow();
});

test("server settings は戻り先 origin と共有 session cookie の Domain を受け取る", () => {
  expect(readServerSettings(validLinkedEnvironment())).toMatchObject({
    appReturnOrigin: "https://app.sandbox.navy1634.com",
    sessionCookieDomain: ".navy1634.com",
  });
});

test.each([
  { SESSION_COOKIE_DOMAIN: ".other.example" },
  { APP_RETURN_ORIGIN: "https://app.other.example" },
  {
    APP_ORIGIN: "https://waiting-room.other.example",
    OIDC_REDIRECT_URI: "https://waiting-room.other.example/auth/callback",
  },
  { APP_RETURN_ORIGIN: "https://app.sandbox.navy1634.com/path" },
  { APP_RETURN_ORIGIN: "http://app.sandbox.navy1634.com" },
  { SESSION_COOKIE_DOMAIN: ".navy1634.com; Secure" },
])(
  "server settings は復帰先または共有Domainの不整合を拒否する %j",
  (invalid) => {
    expect(() =>
      readServerSettings({ ...validLinkedEnvironment(), ...invalid }),
    ).toThrow();
  },
);

test("server settings は OIDC_INTERNAL_URL の省略を拒否する", () => {
  const environment = validServerEnvironment();
  delete environment.OIDC_INTERNAL_URL;

  expect(() => readServerSettings(environment)).toThrow();
});

test("server settings は空の OIDC_INTERNAL_URL を拒否する", () => {
  const environment = validServerEnvironment();
  environment.OIDC_INTERNAL_URL = "";

  expect(() => readServerSettings(environment)).toThrow();
});

test("internal URL に issuer と無関係な HTTPS origin を指定できない", async () => {
  await expectSettingsRejected({
    ...testSettings,
    internalUrl: "https://other.example/api",
  });
});

test("internal URL に外部 HTTP origin を指定できない", async () => {
  await expectSettingsRejected({
    ...testSettings,
    internalUrl: "http://other.example/api",
  });
});

test("loopback issuer でない場合は loopback HTTP internal URL を使えない", async () => {
  await expectSettingsRejected({
    ...testSettings,
    internalUrl: "http://127.0.0.1:8080/api",
  });
});

test("app origin が loopback でない場合は loopback HTTP internal URL を使えない", async () => {
  await expectSettingsRejected({
    ...testSettings,
    appOrigin: "https://waiting-room.example.com",
    issuerUrl: "https://127.0.0.1:1/api",
    internalUrl: "http://127.0.0.1:8080/api",
    redirectUri: "https://waiting-room.example.com/auth/callback",
    allowInsecureLoopback: true,
  });
});

test("公開待合室では HTTP の origin を拒否する", async () => {
  await expectSettingsRejected({
    ...testSettings,
    appOrigin: "http://waiting-room.example.com",
    redirectUri: "http://waiting-room.example.com/auth/callback",
  });
});

test("loopback 以外の HTTP issuer を拒否する", async () => {
  await expectSettingsRejected({
    ...testSettings,
    issuerUrl: "http://auth.example.com/api",
  });
});

test("HTTP の loopback issuer はローカル許可なしでは拒否する", async () => {
  await expectSettingsRejected({
    ...testSettings,
    issuerUrl: "http://localhost:8080/api",
  });
});

test("loopback の insecure 許可を remote issuer に使えない", async () => {
  await expectSettingsRejected({
    ...testSettings,
    allowInsecureLoopback: true,
  });
});

import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { createServer } from "node:net";

// ローカル issuer を使い、sandbox-auth に接続せず OIDC callback を再現する
export type OidcFault =
  | "wrong-state"
  | "bad-pkce"
  | "wrong-nonce"
  | "wrong-issuer"
  | "wrong-audience"
  | "bad-signature"
  | "expired-token";

interface AuthorizationRequest {
  challenge: string;
  clientId: string;
  nonce: string;
  redirectUri: string;
  state: string;
}

interface AuthorizationCode {
  request: AuthorizationRequest;
  fault?: OidcFault;
}

export interface FakeOidcProvider {
  issuer: string;
  internalUrl: string;
  getRequestedPaths: () => string[];
  setExpectedRedirectUri: (redirectUri: string) => void;
  setTokenResponseDelay: (milliseconds: number) => void;
  completeAuthorization: (
    authorizationUrl: string,
    fault?: OidcFault,
  ) => Promise<URL>;
  stop: () => Promise<void>;
}

function normalizeBasePath(pathname: string): string {
  return pathname.replace(/\/+$/, "");
}

function appendPath(baseUrl: string, suffix: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${suffix}`;
}

// Browser 認証だけは公開 URL を使い、テストでは同じ path を local fake へ向ける
function mapPublicUrlToInternal(
  publicUrl: string,
  issuer: string,
  internalUrl: string,
): URL {
  const requestedUrl = new URL(publicUrl);
  const publicBase = new URL(issuer);
  const publicPath = normalizeBasePath(publicBase.pathname);
  const isWithinIssuer =
    publicPath === "" ||
    requestedUrl.pathname === publicPath ||
    requestedUrl.pathname.startsWith(`${publicPath}/`);

  if (requestedUrl.origin !== publicBase.origin || !isWithinIssuer) {
    throw new Error("The test OIDC URL is outside the configured issuer");
  }

  const suffix = publicPath
    ? requestedUrl.pathname.slice(publicPath.length)
    : requestedUrl.pathname;
  const internalBase = new URL(internalUrl);
  internalBase.pathname = `${normalizeBasePath(internalBase.pathname)}${suffix}`;
  internalBase.search = requestedUrl.search;
  internalBase.hash = requestedUrl.hash;

  return internalBase;
}

async function findFreePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();

  if (!address || typeof address === "string") {
    throw new Error("A free local TCP port could not be allocated");
  }

  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });

  return address.port;
}

function signToken(
  claims: Record<string, string | number>,
  key: KeyObject,
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: "vwr-test-key", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signingInput = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();

  return `${signingInput}.${signer.sign(key).toString("base64url")}`;
}

export async function startFakeOidcProvider(
  initialRedirectUri = "",
  publicIssuerUrl?: string,
): Promise<FakeOidcProvider> {
  const port = await findFreePort();
  const localOrigin = `http://127.0.0.1:${port}`;
  const issuer = publicIssuerUrl ?? localOrigin;
  const issuerPath = normalizeBasePath(new URL(issuer).pathname);
  const internalUrl = `${localOrigin}${issuerPath}`;
  const servicePath = (path: string) => `${issuerPath}${path}`;
  const signingKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const invalidKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicJwk = {
    ...signingKeys.publicKey.export({ format: "jwk" }),
    alg: "RS256",
    kid: "vwr-test-key",
    use: "sig",
  };
  const requests = new Map<string, AuthorizationRequest>();
  const codes = new Map<string, AuthorizationCode>();
  const requestedPaths: string[] = [];
  let expectedRedirectUri = initialRedirectUri;
  let tokenResponseDelayMs = 0;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      const url = new URL(request.url);
      requestedPaths.push(url.pathname);

      if (url.pathname === servicePath("/.well-known/openid-configuration")) {
        return Response.json({
          issuer,
          authorization_endpoint: appendPath(issuer, "/authorize"),
          token_endpoint: appendPath(issuer, "/token"),
          jwks_uri: appendPath(issuer, "/jwks"),
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: [
            "client_secret_basic",
            "client_secret_post",
          ],
          code_challenge_methods_supported: ["S256"],
        });
      }

      if (url.pathname === servicePath("/jwks")) {
        return Response.json({ keys: [publicJwk] });
      }

      if (url.pathname === servicePath("/authorize")) {
        return handleAuthorization(
          url,
          expectedRedirectUri,
          requests,
          servicePath("/authorize/complete"),
        );
      }

      if (url.pathname === servicePath("/authorize/complete")) {
        return completeAuthorization(url, requests, codes);
      }

      if (url.pathname === servicePath("/token") && request.method === "POST") {
        return handleToken(
          request,
          issuer,
          expectedRedirectUri,
          codes,
          {
            valid: signingKeys.privateKey,
            invalid: invalidKeys.privateKey,
          },
          tokenResponseDelayMs,
        );
      }

      return new Response("Not found", { status: 404 });
    },
  });

  return {
    issuer,
    internalUrl,
    getRequestedPaths: () => [...requestedPaths],
    setExpectedRedirectUri: (redirectUri) => {
      expectedRedirectUri = redirectUri;
    },
    setTokenResponseDelay: (milliseconds) => {
      tokenResponseDelayMs = milliseconds;
    },
    completeAuthorization: async (authorizationUrl, fault) => {
      const localAuthorizationUrl = mapPublicUrlToInternal(
        authorizationUrl,
        issuer,
        internalUrl,
      );
      const authorizationPage = await fetch(localAuthorizationUrl);
      const page = await authorizationPage.text();
      const href = /href="([^"]+)"/.exec(page)?.[1];

      if (authorizationPage.status !== 200 || !href) {
        throw new Error("The test OIDC authorization request was rejected");
      }

      const completionUrl = new URL(href, internalUrl);

      if (fault) {
        completionUrl.searchParams.set("fault", fault);
      }

      const completed = await fetch(completionUrl, { redirect: "manual" });
      const location = completed.headers.get("location");

      if (completed.status !== 302 || !location) {
        throw new Error(
          "The test OIDC provider did not return a callback redirect",
        );
      }

      return new URL(location);
    },
    stop: () => server.stop(true),
  };
}

function handleAuthorization(
  url: URL,
  expectedRedirectUri: string,
  requests: Map<string, AuthorizationRequest>,
  completionPath: string,
): Response {
  const params = url.searchParams;
  const redirectUri = params.get("redirect_uri");
  const scope = params.get("scope")?.split(/\s+/) ?? [];
  const challenge = params.get("code_challenge");
  const state = params.get("state");
  const nonce = params.get("nonce");

  if (
    params.get("response_type") !== "code" ||
    params.get("client_id") !== "test-client" ||
    redirectUri !== expectedRedirectUri ||
    !scope.includes("openid") ||
    !challenge ||
    params.get("code_challenge_method") !== "S256" ||
    !state ||
    !nonce
  ) {
    return new Response("Invalid OIDC authorization request", { status: 400 });
  }

  const requestId = randomBytes(16).toString("base64url");
  requests.set(requestId, {
    challenge,
    clientId: params.get("client_id") ?? "",
    nonce,
    redirectUri,
    state,
  });

  return new Response(
    `<!doctype html><html><body><a href="${completionPath}?id=${requestId}">Continue</a></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

function completeAuthorization(
  url: URL,
  requests: Map<string, AuthorizationRequest>,
  codes: Map<string, AuthorizationCode>,
): Response {
  const requestId = url.searchParams.get("id");
  const authorization = requestId ? requests.get(requestId) : undefined;

  if (!requestId || !authorization) {
    return new Response("Unknown authorization request", { status: 400 });
  }

  requests.delete(requestId);
  const fault = url.searchParams.get("fault") as OidcFault | null;
  const code = randomBytes(24).toString("base64url");
  codes.set(code, { request: authorization, fault: fault ?? undefined });
  const callback = new URL(authorization.redirectUri);
  callback.searchParams.set("code", code);
  callback.searchParams.set(
    "state",
    fault === "wrong-state"
      ? `${authorization.state}-invalid`
      : authorization.state,
  );

  return Response.redirect(callback, 302);
}

function decodeFormComponent(value: string): string {
  return new URLSearchParams(`value=${value}`).get("value") ?? "";
}

async function handleToken(
  request: Request,
  issuer: string,
  expectedRedirectUri: string,
  codes: Map<string, AuthorizationCode>,
  keys: { valid: KeyObject; invalid: KeyObject },
  tokenResponseDelayMs: number,
): Promise<Response> {
  const form = new URLSearchParams(await request.text());
  const code = form.get("code");
  const authorization = code ? codes.get(code) : undefined;

  if (code) {
    codes.delete(code);
  }

  const authorizationHeader = request.headers.get("authorization");
  const basicCredentials = authorizationHeader?.startsWith("Basic ")
    ? Buffer.from(
        authorizationHeader.slice("Basic ".length),
        "base64",
      ).toString()
    : ":";
  const separator = basicCredentials.indexOf(":");
  const basicClientId = decodeFormComponent(
    separator < 0 ? "" : basicCredentials.slice(0, separator),
  );
  const basicClientSecret = decodeFormComponent(
    separator < 0 ? "" : basicCredentials.slice(separator + 1),
  );
  const clientId = form.get("client_id") ?? basicClientId;
  const clientSecret = form.get("client_secret") ?? basicClientSecret;
  const verifier = form.get("code_verifier") ?? "";
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  if (
    !authorization ||
    form.get("grant_type") !== "authorization_code" ||
    form.get("redirect_uri") !== expectedRedirectUri ||
    clientId !== authorization.request.clientId ||
    clientSecret !== "test-client-secret" ||
    authorization.fault === "bad-pkce" ||
    challenge !== authorization.request.challenge
  ) {
    return Response.json({ error: "invalid_grant" }, { status: 400 });
  }

  if (tokenResponseDelayMs > 0) {
    await Bun.sleep(tokenResponseDelayMs);
  }

  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, string | number> = {
    iss: authorization.fault === "wrong-issuer" ? `${issuer}/invalid` : issuer,
    sub: "test-subject",
    aud: authorization.fault === "wrong-audience" ? "another-client" : clientId,
    exp: authorization.fault === "expired-token" ? now - 1 : now + 3600,
    iat: now,
    nonce:
      authorization.fault === "wrong-nonce"
        ? `${authorization.request.nonce}-invalid`
        : authorization.request.nonce,
  };
  const privateKey =
    authorization.fault === "bad-signature" ? keys.invalid : keys.valid;
  const idToken = signToken(claims, privateKey);

  return Response.json({
    access_token: "test-access-token",
    token_type: "Bearer",
    expires_in: 3600,
    scope: "openid",
    id_token: idToken,
  });
}

import type { FakeOidcProvider, OidcFault } from "./fake-oidc.ts";

export interface StartedAuthorization {
  authorizationUrl: string;
  transactionCookie: string | null;
  response: Response;
}

export async function beginAuthorization(
  appOrigin: string,
  returnTo?: string,
): Promise<StartedAuthorization> {
  const startUrl = new URL("/auth/start", appOrigin);
  if (returnTo !== undefined) {
    startUrl.searchParams.set("return_to", returnTo);
  }
  const response = await fetch(startUrl, {
    redirect: "manual",
  });
  const location = response.headers.get("location");

  return {
    authorizationUrl: location ? new URL(location, appOrigin).href : "",
    transactionCookie: cookiePair(response, "vwr_oidc"),
    response,
  };
}

export async function completeAuthorization(
  provider: FakeOidcProvider,
  started: StartedAuthorization,
  callbackOverride?: URL,
  fault?: OidcFault,
): Promise<Response> {
  // callback override で issuer の動作を変えずに、検証対象の値だけを変えられる
  const callbackUrl =
    callbackOverride ??
    (await provider.completeAuthorization(started.authorizationUrl, fault));
  return sendCallback(started, callbackUrl);
}

export async function sendCallback(
  started: StartedAuthorization,
  callbackUrl: URL,
): Promise<Response> {
  const headers = new Headers();

  if (started.transactionCookie) {
    headers.set("cookie", started.transactionCookie);
  }

  return fetch(callbackUrl, { headers, redirect: "manual" });
}

export function cookiePair(response: Response, name: string): string | null {
  const setCookie = response.headers.get("set-cookie");

  if (!setCookie) {
    return null;
  }

  const cookies = setCookie.split(/,\s*(?=[^;,]+=)/);
  const cookie = cookies.find((value) => value.trim().startsWith(`${name}=`));

  return cookie?.trim().split(";")[0] ?? null;
}

export function cookieValue(response: Response, name: string): string | null {
  const pair = cookiePair(response, name);

  return pair ? pair.slice(name.length + 1) : null;
}

// API・HTML・redirect の全応答で共通する安全な header を管理する
const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

/** 個別応答に security header と no-store を付ける */
export function responseHeaders(contentType: string): Headers {
  const headers = new Headers(SECURITY_HEADERS);
  headers.set("cache-control", "no-store");
  headers.set("content-type", contentType);
  return headers;
}

/** API の JSON 応答を作り、再試行可能な場合は Retry-After を付ける */
export function jsonResponse(
  body: unknown,
  status = 200,
  retryable = false,
): Response {
  const headers = responseHeaders("application/json; charset=utf-8");

  if (retryable) {
    headers.set("retry-after", "1");
  }

  return Response.json(body, { status, headers });
}

/** HTML 応答にも API と同じ cache・security policy を適用する */
export function htmlResponse(
  body: string,
  status = 200,
  retryable = false,
): Response {
  const headers = responseHeaders("text/html; charset=utf-8");

  if (retryable) {
    headers.set("retry-after", "1");
  }

  return new Response(body, { status, headers });
}

/** 認証開始などの redirect を no-store で返す */
export function redirectResponse(location: string, status = 302): Response {
  const headers = responseHeaders("text/plain; charset=utf-8");
  headers.set("location", location);
  return new Response(null, { status, headers });
}

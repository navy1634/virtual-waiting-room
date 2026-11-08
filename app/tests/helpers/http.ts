import type { ApiServer } from "./server.ts";

export async function queueRequest(
  server: ApiServer,
  token: string,
  method: "GET" | "POST" | "DELETE",
  path = "/queue",
): Promise<Response> {
  const headers = new Headers({ cookie: `vwr_session=${token}` });

  if (method !== "GET") {
    // 状態を変える request には same-origin marker を付け、read では付けない
    headers.set("origin", server.origin);
  }

  return fetch(`${server.origin}${path}`, {
    method,
    headers,
    signal: AbortSignal.timeout(10_000),
  });
}

export async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

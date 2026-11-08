// 入場 lease を切らさないよう、利用中のブラウザから定期的に更新する
const HEARTBEAT_INTERVAL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;

export type RenewalResult =
  | { kind: "admitted" }
  | { kind: "unauthenticated" }
  | { kind: "not-admitted" }
  | { kind: "unavailable" };

/** 現在の browser session の入場 lease を API で更新する */
export async function renewAdmission(): Promise<RenewalResult> {
  try {
    const response = await fetch("/queue/renew", {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (response.ok) {
      return { kind: "admitted" };
    }

    if (response.status === 401) {
      return { kind: "unauthenticated" };
    }

    if (response.status === 409) {
      return { kind: "not-admitted" };
    }

    return { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  }
}

/** 入場中だけ更新を繰り返し、停止関数で timer を破棄する */
export function startAdmissionHeartbeat(
  onResult: (result: RenewalResult) => void,
): () => void {
  let stopped = false;
  let timer: number | undefined;

  const tick = async (): Promise<void> => {
    const result = await renewAdmission();

    // 画面遷移後に返った応答では、タイマーを再開しない
    if (stopped) {
      return;
    }

    onResult(result);

    if (result.kind === "admitted") {
      timer = window.setTimeout(() => void tick(), HEARTBEAT_INTERVAL_MS);
    }
  };

  timer = window.setTimeout(() => void tick(), HEARTBEAT_INTERVAL_MS);

  return () => {
    stopped = true;

    if (timer !== undefined) {
      window.clearTimeout(timer);
    }
  };
}

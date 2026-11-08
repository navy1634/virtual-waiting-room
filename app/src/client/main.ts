// 待合画面の状態表示と、認証・待機・退出の操作を束ねる entry point
import "./style.css";
import type { ApiError, QueueState } from "../shared/queue.ts";
import { startAdmissionHeartbeat, type RenewalResult } from "./heartbeat.ts";
import { startProtectedPage } from "./protected.ts";

const POLL_INTERVAL_MS = 10_000;
const REQUEST_TIMEOUT_MS = 10_000;

type ApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: ApiError | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** API の未知の JSON 値から、画面で使う error code だけを取り出す */
function parseApiError(value: unknown): ApiError | null {
  if (!isRecord(value) || typeof value.code !== "string") {
    return null;
  }

  return { code: value.code };
}

/** queue 応答を検証し、画面が扱える状態に絞る */
function parseQueueState(value: unknown): QueueState | null {
  if (
    !isRecord(value) ||
    (value.status !== "waiting" && value.status !== "admitted") ||
    (value.ahead !== null &&
      (!Number.isInteger(value.ahead) || (value.ahead as number) < 0))
  ) {
    return null;
  }

  return {
    status: value.status,
    ahead: value.ahead as number | null,
  };
}

/** JSON API を呼び、HTTP error と通信失敗を画面用の結果へ変換する */
async function requestJson<T>(
  url: string,
  init?: RequestInit,
): Promise<ApiResult<T>> {
  try {
    const response = await fetch(url, {
      ...init,
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const payload: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: parseApiError(payload),
      };
    }

    return { ok: true, value: payload as T };
  } catch {
    return { ok: false, status: 503, error: { code: "UNAVAILABLE" } };
  }
}

/** session を確認し、待機列へ並ぶ画面のイベントと状態遷移を初期化する */
function startWaitingRoom(): void {
  const app = document.querySelector<HTMLElement>("#app");
  const returnTo = new URL(window.location.href).searchParams.get("return_to");

  if (!app) {
    return;
  }

  app.innerHTML = `
    <h1>仮想待合室</h1>
    <p id="status" role="status">状態を確認しています。</p>
    <div class="actions">
      <button id="login" type="button" hidden>ログイン</button>
      <button id="join" type="button" hidden>並ぶ</button>
      <button id="leave" type="button" hidden>退出する</button>
      <a id="protected-link" href="/protected" hidden>保護画面へ進む</a>
      <button id="retry" type="button" hidden>再試行</button>
    </div>
  `;

  const status = app.querySelector<HTMLElement>("#status");
  const login = app.querySelector<HTMLButtonElement>("#login");
  const join = app.querySelector<HTMLButtonElement>("#join");
  const leave = app.querySelector<HTMLButtonElement>("#leave");
  const protectedLink = app.querySelector<HTMLAnchorElement>("#protected-link");
  const retry = app.querySelector<HTMLButtonElement>("#retry");

  if (!status || !login || !join || !leave || !protectedLink || !retry) {
    return;
  }

  let pollTimer: number | undefined;
  let stopped = false;
  let stopHeartbeat = (): void => {};

  const stopPolling = (): void => {
    if (pollTimer !== undefined) {
      window.clearTimeout(pollTimer);
      pollTimer = undefined;
    }
  };

  const reenterWaitingRoom = (): void => {
    stopPolling();
    stopHeartbeat();
    if (returnTo) {
      window.location.replace(`/?return_to=${encodeURIComponent(returnTo)}`);
    }
  };

  // 未認証・未参加・通信障害の画面へ切り替える時は polling と heartbeat を止める
  const showLogin = (): void => {
    if (returnTo) {
      reenterWaitingRoom();
      return;
    }
    stopPolling();
    stopHeartbeat();
    status.textContent = "続けるには sandbox-auth でログインしてください。";
    login.hidden = false;
    join.hidden = true;
    leave.hidden = true;
    protectedLink.hidden = true;
    retry.hidden = true;
  };

  const showJoin = (): void => {
    stopPolling();
    stopHeartbeat();
    status.textContent = "入場を希望する場合は、並ぶ操作を行ってください。";
    login.hidden = true;
    join.hidden = false;
    leave.hidden = true;
    protectedLink.hidden = true;
    retry.hidden = true;
  };

  const showUnavailable = (): void => {
    stopPolling();
    stopHeartbeat();
    status.textContent =
      "現在、状態を確認できません。時間をおいて再試行してください。";
    login.hidden = true;
    join.hidden = true;
    leave.hidden = true;
    protectedLink.hidden = true;
    retry.hidden = false;
  };

  // 待機中は待ち人数を定期確認し、入場中は lease の更新だけを続ける
  const showState = (state: QueueState): void => {
    if (state.status === "admitted" && returnTo) {
      // 外部 URL へは直接遷移せず、サーバーで復帰先と入場状態を再確認する
      reenterWaitingRoom();
      return;
    }
    status.textContent =
      state.status === "admitted"
        ? "入場できます。保護画面へ進んでください。"
        : `前に ${state.ahead ?? 0} 人が待っています。`;
    login.hidden = true;
    join.hidden = true;
    leave.hidden = Boolean(returnTo);
    protectedLink.hidden = state.status !== "admitted";
    retry.hidden = true;

    if (state.status === "admitted") {
      // 入場後は待機位置の確認を止め、入場 lease の更新へ切り替える
      stopPolling();
      stopHeartbeat();
      stopHeartbeat = startAdmissionHeartbeat(handleRenewal);
    } else {
      stopHeartbeat();
    }
  };

  const handleError = (result: ApiResult<unknown>): void => {
    if (result.ok) {
      return;
    }

    if (result.status === 401 || result.error?.code === "AUTH_REQUIRED") {
      showLogin();
      return;
    }

    if (result.status === 409 && result.error?.code === "QUEUE_NOT_JOINED") {
      if (returnTo) {
        reenterWaitingRoom();
        return;
      }
      showJoin();
      return;
    }

    showUnavailable();
  };

  const handleRenewal = (result: RenewalResult): void => {
    if (result.kind === "admitted") {
      return;
    }

    if (result.kind === "unauthenticated") {
      showLogin();
      return;
    }

    if (result.kind === "not-admitted") {
      if (returnTo) {
        reenterWaitingRoom();
        return;
      }
      showJoin();
      return;
    }

    showUnavailable();
  };

  // 待機中は位置を再確認し、入場後は polling を止めて lease 更新へ切り替える
  const poll = async (): Promise<void> => {
    if (stopped) {
      return;
    }

    const result = await requestJson<unknown>("/queue");

    if (result.ok) {
      const state = parseQueueState(result.value);

      if (!state) {
        showUnavailable();
        return;
      }

      showState(state);

      if (state.status === "waiting") {
        pollTimer = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
      }

      return;
    }

    handleError(result);
  };

  // 有効な session を使い、未参加の利用者を待機列へ登録する
  const handleJoin = async (): Promise<void> => {
    join.disabled = true;
    const result = await requestJson<unknown>("/queue", { method: "POST" });
    join.disabled = false;

    if (!result.ok) {
      handleError(result);
      return;
    }

    const state = parseQueueState(result.value);

    if (!state) {
      showUnavailable();
      return;
    }

    showState(state);

    if (state.status === "waiting") {
      pollTimer = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
    }
  };

  // 退出後は session を保ち、queue と入場枠を解放する
  const handleLeave = async (): Promise<void> => {
    leave.disabled = true;

    try {
      const response = await fetch("/queue", {
        method: "DELETE",
        cache: "no-store",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (response.status === 204) {
        showJoin();
      } else if (response.status === 401) {
        showLogin();
      } else {
        showUnavailable();
      }
    } catch {
      showUnavailable();
    } finally {
      leave.disabled = false;
    }
  };

  // ボタン操作を API または認証開始へ結び、ページ離脱時は timer を止める
  login.addEventListener("click", () => {
    window.location.assign(
      returnTo ? `/?return_to=${encodeURIComponent(returnTo)}` : "/auth/start",
    );
  });

  join.addEventListener("click", () => {
    void handleJoin();
  });

  leave.addEventListener("click", () => {
    void handleLeave();
  });

  retry.addEventListener("click", () => {
    retry.disabled = true;
    void poll().finally(() => {
      retry.disabled = false;
    });
  });

  window.addEventListener(
    "pagehide",
    () => {
      stopped = true;
      stopPolling();
      stopHeartbeat();
    },
    { once: true },
  );

  void poll();
}

if (document.body.dataset.page === "protected") {
  void startProtectedPage();
} else {
  startWaitingRoom();
}

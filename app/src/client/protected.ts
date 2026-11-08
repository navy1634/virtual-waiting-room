// 保護画面の内容は、サーバー確認と最初の lease 更新が通るまで表示しない
import {
  renewAdmission,
  startAdmissionHeartbeat,
  type RenewalResult,
} from "./heartbeat.ts";

/** 入場資格を再確認し、認証・再入場・再試行の導線を表示する */
export async function startProtectedPage(): Promise<void> {
  const content = document.querySelector<HTMLElement>("#protected-content");
  const status = document.querySelector<HTMLElement>("#protected-status");

  if (!content || !status) {
    return;
  }

  content.hidden = true;
  let stopHeartbeat = (): void => {};

  const showUnavailable = (): void => {
    status.textContent =
      "現在、入場状態を確認できません。時間をおいて再試行してください。";
    let retry = document.querySelector<HTMLButtonElement>("#protected-retry");

    if (!retry) {
      retry = document.createElement("button");
      retry.id = "protected-retry";
      retry.type = "button";
      retry.textContent = "再試行";
      status.after(retry);
    }

    retry.onclick = () => {
      retry.disabled = true;
      void checkAdmission().finally(() => {
        if (retry) {
          retry.disabled = false;
        }
      });
    };
  };

  const showLogin = (): void => {
    status.textContent =
      "認証の有効期限が切れました。もう一度ログインしてください。";
    let login = document.querySelector<HTMLAnchorElement>("#protected-login");

    if (!login) {
      login = document.createElement("a");
      login.id = "protected-login";
      login.href = "/auth/start";
      login.textContent = "ログイン";
      status.after(login);
    }
  };

  // lease の結果を画面へ反映し、資格を失った場合は内容を隠して次の導線へ戻す
  const handleRenewal = (result: RenewalResult): void => {
    if (result.kind === "admitted") {
      document.querySelector("#protected-retry")?.remove();
      document.querySelector("#protected-login")?.remove();
      content.hidden = false;
      status.textContent = "入場状態を確認しています。";
      return;
    }

    // 入場状態を失った場合や確認できない場合は、処理分岐の前に内容を隠す
    content.hidden = true;
    stopHeartbeat();

    if (result.kind === "not-admitted") {
      window.location.replace("/");
      return;
    }

    if (result.kind === "unauthenticated") {
      showLogin();
      return;
    }

    showUnavailable();
  };

  // 初回確認と再試行は同じ更新処理を使い、成功後に周期更新を開始する
  async function checkAdmission(): Promise<void> {
    const result = await renewAdmission();
    handleRenewal(result);

    if (result.kind === "admitted") {
      stopHeartbeat = startAdmissionHeartbeat(handleRenewal);
    }
  }

  await checkAdmission();
}

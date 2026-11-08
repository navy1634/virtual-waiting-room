// 設定検証から DB 確認、依存の組み立て、HTTP listen までを担当する起動入口
import { PostgresWaitingRoomStore } from "../waiting-room/store.ts";
import { WaitingRoomService } from "../waiting-room/service.ts";
import { OidcClient } from "../auth/oidc.ts";
import { buildClientAssets } from "./client-assets.ts";
import { readServerSettings } from "./config.ts";
import { createHttpApp } from "./routes.ts";

/** 依存先を準備してから listen し、終了時は server と DB pool を閉じる */
async function startServer(): Promise<void> {
  const settings = readServerSettings(Bun.env);
  // 他の依存が共有する DB pool を先に作り、初期化失敗時にも閉じられるよう try で管理する
  const store = new PostgresWaitingRoomStore(
    settings.databaseUrl,
    settings.waitingRoomCapacity,
  );

  try {
    // store を共有する service と OIDC client、配信する browser assets をまとめて組み立てる
    const application = {
      appOrigin: settings.appOrigin,
      appReturnOrigin: settings.appReturnOrigin,
      sessionCookieDomain: settings.sessionCookieDomain,
      secureCookies: settings.secureCookies,
      waitingRoom: new WaitingRoomService(store),
      oidc: new OidcClient(
        {
          appOrigin: settings.appOrigin,
          issuerUrl: settings.oidcIssuerUrl,
          internalUrl: settings.oidcInternalUrl,
          clientId: settings.oidcClientId,
          clientSecret: settings.oidcClientSecret,
          redirectUri: settings.oidcRedirectUri,
          allowInsecureLoopback: settings.allowInsecureLoopback,
        },
        store,
      ),
      assets: await buildClientAssets(),
    };
    const httpApp = createHttpApp(application);
    // 設定・DB・client assets の準備が全て終わってから port を開く
    const server = Bun.serve({
      hostname: settings.host,
      port: settings.port,
      fetch: (request) => httpApp.fetch(request),
    });

    process.once("SIGTERM", () => {
      void (async () => {
        // HTTP server を停止してから DB pool を閉じる
        await server.stop(true);
        await store.close();
      })().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  } catch (error) {
    // listen 前の初期化失敗でも DB connection を残さない
    await store.close();
    throw error;
  }
}

await startServer().catch(() => {
  console.error("Waiting room server startup failed");
  process.exitCode = 1;
});

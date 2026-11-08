# 仮想待合室

## 概要

同時に有効にできるブラウザーセッション数を上限 `N` 以下に制限する。
空き枠ができると、利用者を待機順に入場させる。
同じブラウザーの複数タブは、一つのセッションとして扱う。

## アーキテクチャ

ブラウザー画面と Hono API は Bun 上で動き、同じ origin から配信する。
待機状態は PostgreSQL に保存する。
同時に入場できる session 数の上限は `WAITING_ROOM_CAPACITY` で設定する。
sandbox_app からの入場では待合室から認証サービスを呼ばず、アプリ側の認証の有無や順序は変更しない。
復帰先を設定しない待合室単体のログインには OIDC 認証サービスの [sandbox-auth](https://github.com/navy1634/sandbox-auth) を使う。

ローカル DB と migration の起動手順は [リポジトリの README](../README.md) を参照する。

## sandbox_app からの入場と復帰

sandbox_app は元の絶対 URL を `return_to` に URL エンコードして、待合室の `GET /?return_to=...` へ利用者を送る。
`APP_RETURN_ORIGIN` を設定した環境では、待合室の `GET /` への直接アクセスも、設定済みアプリoriginのルートURLを復帰先とする `return_to` 付き入口へ自動でredirectする。
直接アクセスでもアプリ経由でも参加と復帰は自動で行い、ログイン・並ぶ・保護画面へ進む操作は求めない。
`/auth/start` は待合室単体のログイン専用とし、`return_to` がある場合は OIDC を開始せず400で拒否する。
待合室は起動時に検証した `APP_RETURN_ORIGIN` と scheme・host・port が完全一致する URL だけを受け付け、相対 URL、認証情報付き URL、外部 origin への復帰を拒否する。
元 URL の path・query・fragment は入場まで保持する。
`return_to` の重複指定や不正な値は400で拒否する。

`return_to` 付きのアクセスでは認証サービスを呼ばず、暗号学的乱数による匿名 session の Cookie を発行して既存の入場処理へ自動参加する。
DB には token の hash だけを保存し、OIDC subject は保存しない。
session の有効期限は発行から1時間とし、既存の待機期限と入場 lease も適用する。
空き枠があれば DB トランザクション内で容量を確保して、待機画面を表示せず元 URL へ302で戻す。
満席の場合だけ既存の FIFO queue で待機し、画面が入場を検知したらサーバーで復帰先と入場状態を再確認して元 URL へ自動で戻す。
通常の待機画面では待機状態だけを表示し、手動参加や退出の操作は表示しない。
待機期限が切れた場合も同じ匿名 session で自動再参加し、その時点の FIFO 末尾から待つ。
`APP_RETURN_ORIGIN` を設定しない場合に限り、従来の待合室単体の動作を維持する。

`APP_RETURN_ORIGIN` は path・query・fragment・認証情報を含まない HTTPS origin を指定する。
ローカル開発では loopback の HTTP origin も指定できる。
省略時は sandbox_app への復帰を受け付けない。
`SESSION_COOKIE_DOMAIN` は任意であり、設定する場合は `APP_ORIGIN` と `APP_RETURN_ORIGIN` の両方の hostname に一致するか、その親ドメインでなければ起動を拒否する。
HTTP の loopback 待合室を使うテストでは、`APP_ORIGIN` への Domain 照合だけを省略するが、`APP_RETURN_ORIGIN` への照合は常に行う。
この例外は Cookie の共有を可能にするものではないため、ローカル開発では `SESSION_COOKIE_DOMAIN` を空にして host 限定 Cookie を使う。
`vwr_session` の発行時と削除時には指定した Domain を付け、省略時は Domain を付けない。
OIDC トランザクション Cookie は待合室の host に限定する。
連携フローでは OIDC トランザクション Cookie を発行しない。

### 待機と入場枠の詳細

待機画面は状態を確認し、待機中は各応答の10秒後に再び確認する。
待機中の確認によって待機期限を更新するため、同じ session で再度参加しても待機順序は変わらない。
60秒間確認されなかった待機状態は期限切れとなり、匿名連携では同じ有効な session で待機列の末尾から自動的に再参加する。

入場枠は入場時または最後の正常な更新から120秒間有効で、入場中のブラウザーは30秒ごとに更新する。
ブラウザーを閉じても枠は即時には解放されず、更新が止まった後に有効期限が切れると空き枠として扱われる。
ただし session 自体の有効期限は発行から1時間であり、その期限が先に切れた場合も枠は無効となる。
匿名連携では期限切れの session の代わりに新しい session を発行し、待機列へ再参加する。

期限切れの整理と空き枠の割り当ては待機列の操作時に行い、空き枠は待機順に割り当てる。
待機画面は割り当て後の次の状態確認で入場を検知し、アプリへ自動で戻る。
「前に N 人が待っています」の人数は待機列内で自分より前にいる人数であり、入場中の利用者は含まない。
そのため、前に0人と表示されていても、入場枠がすべて使用中であれば待機する。

## 環境変数

環境変数の見本は [`.env.example`](.env.example) にある。実値は `app/.env` に設定する。
環境ファイルの作成とローカル DB のパスワード設定は [リポジトリの README](../README.md) を参照する。

- `DATABASE_HOST`: PostgreSQL の hostname。ローカルでは `127.0.0.1` を使う
- `DATABASE_PORT`: PostgreSQL の port。ローカルの公開 port は `5433`
- `DATABASE_NAME`: 接続する database 名
- `DATABASE_USER`: 接続する database user
- `DATABASE_PASSWORD`: 接続する database password
- `DATABASE_SSLMODE`: PostgreSQL 接続の TLS mode
- `WAITING_ROOM_CAPACITY`: 同時に入場できる session 数の上限。整数を指定
- `APP_ORIGIN`: ブラウザーからアクセスするアプリの origin
- `APP_RETURN_ORIGIN` には `https://app.sandbox.navy1634.com` を指定する。待合室はこの origin と一致する sandbox_app の URL にだけ利用者を戻す
- `SESSION_COOKIE_DOMAIN` には `.navy1634.com` を指定する。待合室と sandbox_app 間で `vwr_session` cookie を共有する
- `OIDC_ISSUER_URL`: sandbox-auth の issuer URL
- `OIDC_INTERNAL_URL`: 必須。server-side OIDC 通信に使う URL。ローカルでは公開 issuer URL、Kubernetes では sandbox-auth の内部 Service URL を指定する
- `OIDC_CLIENT_ID`: sandbox-auth に登録した client ID
- `OIDC_CLIENT_SECRET`: 同じ OIDC client の secret
- `OIDC_REDIRECT_URI`: `${APP_ORIGIN}/auth/callback` と完全に一致させる
- `HOST`: listen address。省略時は `127.0.0.1`
- `PORT`: listen port。省略時は `3100`

## 起動

リポジトリの README に従ってローカル PostgreSQL を起動し、migration を適用してから、`app/` で開発サーバーを起動する。

```sh
cd app
bun run dev
```

`APP_ORIGIN` に設定した URL をブラウザーで開く。

## コマンド

以下の Bun scripts は `app/` で実行する。

| コマンド                  | 用途                              |
| ------------------------- | --------------------------------- |
| `bun run dev`             | 開発サーバーの起動                |
| `bun run build`           | ブラウザー資産とサーバーの build  |
| `bun run lint`            | Oxlint の実行                     |
| `bun run typecheck`       | TypeScript の型確認               |
| `bun run format`          | Oxfmt による整形                  |
| `bun run format:check`    | 整形が必要なファイルの確認        |
| `bun run browser:install` | Playwright 用 Chromium の準備     |
| `bun run test:unit`       | unit test の実行                  |
| `bun run test:e2e`        | Playwright の browser test の実行 |
| `bun run test`            | unit test と browser test の実行  |

## テスト

テストには Docker Engine が必要である。
Testcontainers が一時 PostgreSQL を起動し、テスト後に破棄する。
HTTP 統合テストはローカルの OIDC test issuer を使う。
browser test の匿名連携では loopback HTTP サーバーを復帰先に使い、認証サービスが停止していても入場できることを確認する。
browser test の初回実行前に `bun run browser:install` を実行する。

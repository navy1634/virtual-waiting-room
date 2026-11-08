# virtual-waiting-room

これは、同時に有効なブラウザーセッション数を制限し、空き枠を待機順に割り当てる仮想待合室である。

## リポジトリ構成

| パス          | 責務                                                                                                                 |
| ------------- | -------------------------------------------------------------------------------------------------------------------- |
| `app/`        | Bun で動くブラウザーアプリと API、アプリ用 image、アプリ固有のテストや設定。[README](app/README.md) に開発手順を記載 |
| `db/`         | PostgreSQL migration の正本、migration 用 image、Compose 用環境変数の見本                                            |
| `compose.yml` | ローカル PostgreSQL と migration の実行設定                                                                          |
| `manifests/`  | Kubernetes の共通設定と環境別設定。[README](manifests/README.md) に配置手順を記載                                    |

`db/migrations/` を schema の正本とする。Compose と Kubernetes の migration image、app のテスト helper は同じ SQL を使う。アプリ用 image には migration SQL を含めない。

## ローカル開発

ローカル開発には mise、Bun、Docker Compose が必要である。
アプリ固有の環境変数は [app/README.md](app/README.md) を参照する。

リポジトリのルートで環境ファイルを用意する。

```sh
cp -n db/.env.example .env
cp -n app/.env.example app/.env
```

`.env` の `POSTGRES_PASSWORD` と `app/.env` の `DATABASE_PASSWORD` に同じパスワードを設定する。

### 起動

mise の tool installation は `app/` と `db/`、Bun のコマンドは `app/`、Compose のコマンドはリポジトリのルートから実行する。

アプリの依存ツールを用意する。

```sh
cd app
mise install
bun install --frozen-lockfile
cd ../db
mise install
cd ..
```

PostgreSQL を起動する。

```sh
docker compose up -d --wait db
```

Compose の migration service は `db/migrations/` の SQL を適用する。
DB が healthy になってから実行する。

```sh
docker compose run --build --rm migrate
```

DB の準備ができたら、[app README の起動手順](app/README.md#起動)でアプリを起動し、`APP_ORIGIN` に設定した URL を開く。

アプリを停止してから PostgreSQL を停止する。

```sh
docker compose down
```

### コンテナイメージ

アプリ image と migration image は、それぞれのディレクトリで build する。

```sh
cd app
docker build . -t virtual-waiting-room:dev
cd ../db
docker build . -t virtual-waiting-room-migrations:dev
cd ..
```

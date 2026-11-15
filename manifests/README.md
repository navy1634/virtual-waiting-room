# Kubernetes マニフェスト

共通リソースは `base/`、環境固有の設定は `overlays/<environment>/` に置く。
適用時は対象環境の overlay を指定する。

Deployment は migration 用 init container と app container に別々の image を使う。
環境ごとの tag は overlay の `kustomization.yaml` で個別に管理する（現在の設定は [`overlays/prd/kustomization.yaml`](overlays/prd/kustomization.yaml) を参照）。
アプリの変更時は app image の tag を、migration の変更時は migration image の tag を更新する。
変更した image を build・push し、対象 overlay の `newTag` を更新して `main` にマージする。
prd Application は Argo CD で差分を確認してから手動同期する。
build と push には、対象 overlay の `newTag` と同じ tag を指定する。
以下の例の `<app-tag>` と `<migration-tag>` は、対応する `newTag` の値に置き換える。

app image は `app/` で build・push する。

```sh
cd app
docker build . -t registry.local:5000/virtual-waiting-room:<app-tag>
docker push registry.local:5000/virtual-waiting-room:<app-tag>
```

migration image は `db/` で build・push する。

```sh
cd db
docker build . -t registry.local:5000/virtual-waiting-room-migrations:<migration-tag>
docker push registry.local:5000/virtual-waiting-room-migrations:<migration-tag>
```

app の公開先は `https://waiting-room.navy1634.com` である。
OIDC issuer は [sandbox-auth](https://github.com/navy1634/sandbox-auth) の `https://auth.sandbox.navy1634.com/api` である。
issuer は sandbox-auth が公開する認証サービスの識別子であり、アプリの公開先とは別の値である。
app の server-side 通信先には `OIDC_INTERNAL_URL` を設定し、sandbox-auth の ClusterIP Service を使う。
ブラウザー向けの認可 URL と issuer の識別子には公開 URL を使う。

callback URI は `https://waiting-room.navy1634.com/auth/callback` である。
sandbox-auth の OIDC client に登録する。
公開先の証明書と対応する秘密鍵を `waiting-room-tls` Secret に設定する。証明書と鍵はリポジトリに含めない。

```sh
kubectl -n sandbox-waiting-room delete secret waiting-room-tls
kubectl -n sandbox-waiting-room create secret tls waiting-room-tls \
  --cert=/path/to/waiting-room.navy1634.com.pem \
  --key=/path/to/waiting-room.navy1634.com-key.pem
```

```sh
kubectl kustomize manifests/overlays/prd
```

## Argo CD への登録

環境ごとの Argo CD 設定は `argocd/<environment>/`、workload は `overlays/<environment>/` に置く。
Application と AppProject の名前は `virtual-waiting-room` とする。
Application の destination namespace は workload overlay の namespace と合わせ、Project の許可先にも登録する。

登録前に `kubectl config current-context` で対象環境の cluster を確認し、`manifests/` から対応する設定を適用する。

prd cluster には `kubernetes.io/hostname=prd-server` の node が必要である。
PV はその node 上に `/var/lib/prd-waiting-room/database` を作成する。
`waiting-room-tls`、`virtual-waiting-room-postgres-secret`、`virtual-waiting-room-app-secret` は `sandbox-waiting-room` namespace に別途作成する。
prd Application は手動同期とし、main にレビュー承認と必須の CI check が設定されるまでは自動配備を有効にしない。

prd cluster へ登録する場合は、その cluster の context を選び、次を実行する。

```sh
cd manifests
kubectl config current-context
kubectl apply -k argocd/prd
```

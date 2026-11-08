FROM oven/bun:1.4.4-alpine AS build

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY src ./src
# dev dependency がある間に browser 資産を作り、その後 dev dependency を除く
RUN bun run build \
  && bun install --production --frozen-lockfile

FROM oven/bun:1.4.4-alpine AS runtime

ENV HOST=0.0.0.0 \
  HOME=/tmp \
  NODE_ENV=production \
  PORT=3100

WORKDIR /app

# 最終 image には実行用ファイルだけを残し、root 以外で起動する
COPY --from=build --chown=10001:10001 /app/node_modules ./node_modules
COPY --from=build --chown=10001:10001 /app/package.json ./package.json
COPY --from=build --chown=10001:10001 /app/src ./src

USER 10001:10001

EXPOSE 3100

CMD ["bun", "src/server/http/server.ts"]

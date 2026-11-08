FROM alpine:3.22 AS base

ARG DBMATE_VERSION=2.37.0
ARG DBMATE_SHA256=f855e99a0f0a81322014bf686b1cb820d2b4d8074e4eadafd64b851b80ecb15a

RUN apk add --no-cache ca-certificates curl \
  && curl -fsSL \
    "https://github.com/amacneil/dbmate/releases/download/v${DBMATE_VERSION}/dbmate-linux-amd64" \
    -o /usr/local/bin/dbmate \
  && printf '%s  %s\n' "$DBMATE_SHA256" /usr/local/bin/dbmate \
    | sha256sum -c - \
  && chmod 0755 /usr/local/bin/dbmate

FROM alpine:3.22

RUN apk add --no-cache ca-certificates

WORKDIR /app

COPY --from=base /usr/local/bin/dbmate /usr/local/bin/dbmate
COPY migrations ./db/migrations

USER 10001:10001

ENTRYPOINT ["dbmate"]

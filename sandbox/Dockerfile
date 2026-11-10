# 作業場（ジョブ専用コンテナ）のイメージ。設計: docs/design/03 5章、specs/003-sandbox-tools/research.md R11
# 作業場はネットワークなしで動くので、使う道具はここで入れておく。
FROM node:24-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git ripgrep \
 && rm -rf /var/lib/apt/lists/*

# pnpm は corepack で入れておき、作業場の中でダウンロードさせない
ENV COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable \
 && corepack install --global pnpm@12.18.0 \
 && chmod -R a+rX /opt/corepack \
 && cd /tmp && pnpm --version

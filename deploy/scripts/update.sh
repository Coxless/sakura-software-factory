#!/usr/bin/env bash
# ファクトリーを指定の版に更新する（root で実行）。使い方: update.sh [ref]（既定 origin/main）
# 仕様: specs/006-vps-ops/contracts/deploy.md
set -euo pipefail

# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

REF="${1:-origin/main}"

require_root
use_pinned_node

step "取得"
git -C "$APP_DIR" fetch --tags origin

step "チェックアウト"
git -C "$APP_DIR" checkout --quiet --detach "$REF"
commit="$(git -C "$APP_DIR" rev-parse HEAD)"

step "依存"
(cd "$APP_DIR" && pnpm install --frozen-lockfile --prod)

step "作業場のイメージ"
docker build --quiet -t factory-sandbox:latest "${APP_DIR}/sandbox"

step "マイグレーション"
# データの置き場所と DB のファイルは factory だけが読めるようにする（ユニットの UMask=0027 と同じ）
install -d -o "$FACTORY_USER" -g "$FACTORY_USER" -m 0750 "$STATE_DIR"
(
  umask 0027
  runuser -u "$FACTORY_USER" -- env "FACTORY_CONFIG=${ETC_DIR}/factory.toml" \
    "${NODE_DIR}/bin/node" "${APP_DIR}/src/migrate.ts"
)

step "再起動"
systemctl restart factory

step "生存確認"
healthy=0
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${FACTORY_PORT}/healthz" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 1
done
if [[ "$healthy" -ne 1 ]]; then
  journalctl -u factory -n 50 --no-pager >&2 || true
  die "30 秒待っても /healthz が正常になりません（上のログを確かめてください）"
fi

step "版の表示"
printf 'deployed %s (%s)\n' "$commit" "$REF"

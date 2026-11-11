#!/usr/bin/env bash
# 配備スクリプト（setup.sh・update.sh）が共通で使う定数と関数。source して使う。
# 仕様: specs/006-vps-ops/contracts/deploy.md
# 定数は source した側で使うので、未使用の警告を止める
# shellcheck disable=SC2034

# 版の固定（specs/006-vps-ops/research.md R8）
NODE_VERSION="24.22.2"
CADDY_VERSION="2.11.9"

# VPS 上の配置（specs/006-vps-ops/data-model.md の DeployLayout）
APP_DIR="/opt/sakura-factory/app"
ETC_DIR="/etc/sakura-factory"
STATE_DIR="/var/lib/sakura-factory"
NODE_DIR="/opt/node"
FACTORY_USER="factory"
# factory.toml の [http].port と deploy/Caddyfile に合わせる
FACTORY_PORT="8787"

CURRENT_STEP="(開始前)"

# 手順の名前を出し、失敗したときに示せるよう覚えておく
step() {
  CURRENT_STEP="$1"
  printf '\n==> %s\n' "$CURRENT_STEP"
}

# 手順の名前と理由を出して止まる
die() {
  printf 'ERROR: %s で失敗しました: %s\n' "$CURRENT_STEP" "$1" >&2
  exit 1
}

# 予期しない失敗（set -e で止まった場合）も、どの手順で止まったかを出す
on_error() {
  local status=$?
  printf 'ERROR: %s で失敗しました（終了コード %s）\n' "$CURRENT_STEP" "$status" >&2
  exit "$status"
}
trap on_error ERR

require_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    die "root で実行してください（sudo を付ける）"
  fi
}

# corepack で pnpm を使えるよう、固定した Node を PATH の先頭に置く
use_pinned_node() {
  export PATH="${NODE_DIR}/bin:${PATH}"
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
}

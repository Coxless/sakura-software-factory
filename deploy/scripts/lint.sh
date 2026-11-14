#!/usr/bin/env bash
# 配備物の文法の検査（pnpm run deploy:lint）。ローカル（Workshop）と CI で同じものを実行する。
# 仕様: specs/006-vps-ops/contracts/commands.md、research.md R14
set -euo pipefail

cd "$(dirname "$0")/../.."

CADDY_IMAGE="caddy:2.11.9"
failed=0

ok() { printf 'ok   %s\n' "$1"; }
ng() {
  printf 'NG   %s\n' "$1" >&2
  failed=1
}

# --- shellcheck: 配備スクリプトと共有のスクリプト ---
mapfile -t shell_files < <(find deploy scripts -name '*.sh' -type f | sort)
if ! command -v shellcheck >/dev/null 2>&1; then
  ng "shellcheck がありません（Workshop は setup-base で入る。CI のランナーには最初からある）"
elif shellcheck --external-sources --source-path=SCRIPTDIR "${shell_files[@]}"; then
  ok "shellcheck（${#shell_files[@]} ファイル）"
else
  ng "shellcheck"
fi

# --- systemd: ユニットの文法 ---
# ExecStart の /opt/node/bin/node は検査する機械にないので、写しを /bin/true に置き換えて検査する。
# 知らない設定名は警告だけで終了コードが 0 になるので、出力が1行でもあれば失敗にする
if ! command -v systemd-analyze >/dev/null 2>&1; then
  ng "systemd-analyze がありません"
else
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  for unit in deploy/systemd/*.service; do
    copy="${work}/$(basename "$unit")"
    sed 's#^ExecStart=/opt/node/bin/node #ExecStart=/bin/true #' "$unit" >"$copy"
    if output="$(systemd-analyze verify "$copy" 2>&1)" && [[ -z "$output" ]]; then
      ok "systemd-analyze verify $(basename "$unit")"
    else
      printf '%s\n' "$output" >&2
      ng "systemd-analyze verify $(basename "$unit")"
    fi
  done
  # drop-in は [Service] と EnvironmentFile= だけにする
  for dropin in deploy/systemd/*.service.d/*.conf; do
    if grep -vE '^(#.*|\s*|\[Service\]|EnvironmentFile=/etc/caddy/caddy\.env)$' "$dropin" >/dev/null; then
      ng "drop-in に想定外の行があります: ${dropin}"
    else
      ok "drop-in $(basename "$dropin")"
    fi
  done
fi

# --- Caddy: 設定の検証と書式 ---
if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  ng "Docker が必要です（Caddy の検査に ${CADDY_IMAGE} を使う）"
else
  if docker run --rm -v "$PWD/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" \
    -e FACTORY_DOMAIN=factory.test -e STAGING_DOMAIN=staging.test -e CADDY_TLS=internal \
    "$CADDY_IMAGE" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >"${TMPDIR:-/tmp}/caddy-validate.log" 2>&1; then
    ok "caddy validate"
  else
    cat "${TMPDIR:-/tmp}/caddy-validate.log" >&2
    ng "caddy validate"
  fi
  # caddy fmt --diff は差があっても終了コードが 0 なので、整形した結果と diff で比べる
  formatted="$(docker run --rm -i "$CADDY_IMAGE" caddy fmt - <deploy/Caddyfile)"
  if diff -u deploy/Caddyfile <(printf '%s\n' "$formatted") >&2; then
    ok "caddy fmt"
  else
    ng "caddy fmt（上の差のとおりに直す）"
  fi
fi

# --- ステージングの compose（010）: 定義の検証 ---
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  ng "docker compose が必要です（deploy/staging/compose.yaml の検査）"
elif STAGING_IMAGE=lint:check STAGING_PORT=3100 \
  docker compose -p sakura-staging-lint -f deploy/staging/compose.yaml config -q; then
  ok "docker compose config（deploy/staging/compose.yaml）"
else
  ng "docker compose config（deploy/staging/compose.yaml）"
fi

exit "$failed"

#!/usr/bin/env bash
# VPS（Ubuntu 24.04）にファクトリーを配備する（root で実行）。何度流しても同じ結果になる。
# 運用者は先にリポジトリを /opt/sakura-factory/app に clone し、そこのこのスクリプトを流す。
# 仕様: specs/006-vps-ops/contracts/deploy.md、手順書: deploy/README.md
#
# 環境変数:
#   FACTORY_REPO_URL  取得元（既定は GitHub。予行演習では git bundle のパス）
#   FACTORY_REF       チェックアウトするコミットかタグ（既定 origin/main）
#   FACTORY_SKIP_SSH  1 なら SSH の設定を飛ばす（予行演習だけ。コンテナに SSH の鍵がないため）
set -euo pipefail

# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

FACTORY_REPO_URL="${FACTORY_REPO_URL:-https://github.com/Coxless/sakura-software-factory.git}"
FACTORY_REF="${FACTORY_REF:-origin/main}"
FACTORY_SKIP_SSH="${FACTORY_SKIP_SSH:-0}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

require_root
export DEBIAN_FRONTEND=noninteractive

# 権限の絞ったファイル（秘密情報）を確かめる。なければひな形を置いて止まる
check_secret_file() {
  local path="$1" template="$2" group="$3"
  shift 3
  if [[ ! -f "$path" ]]; then
    install -o root -g "$group" -m 0640 "$template" "$path"
    die "${path} を作りました。値を書いてから setup.sh を流し直してください"
  fi
  local owner mode
  owner="$(stat -c '%U:%G' "$path")"
  mode="$(stat -c '%a' "$path")"
  if [[ "$owner" != "root:${group}" || "$mode" != "640" ]]; then
    die "${path} の所有者と権限を root:${group}・640 にしてください（現在 ${owner}・${mode}）"
  fi
  local name
  for name in "$@"; do
    if ! grep -qE "^${name}=.+" "$path"; then
      die "${path} の ${name} が空です"
    fi
  done
}

step "パッケージ"
apt-get update -q
apt-get install -y -q --no-install-recommends \
  ca-certificates curl git ripgrep sqlite3 docker.io docker-compose-v2 ufw shellcheck \
  debian-keyring debian-archive-keyring apt-transport-https gnupg xz-utils
systemctl enable --now docker

step "Node.js"
node_root="/opt/node-v${NODE_VERSION}"
if [[ ! -x "${node_root}/bin/node" ]]; then
  tarball="node-v${NODE_VERSION}-linux-x64.tar.xz"
  work="$(mktemp -d)"
  curl -fsSL --retry 3 -o "${work}/${tarball}" "https://nodejs.org/dist/v${NODE_VERSION}/${tarball}"
  curl -fsSL --retry 3 -o "${work}/SHASUMS256.txt" "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
  (cd "$work" && grep " ${tarball}\$" SHASUMS256.txt | sha256sum -c --quiet -) ||
    die "Node.js のチェックサムが一致しません"
  mkdir -p "$node_root"
  tar -xJf "${work}/${tarball}" -C "$node_root" --strip-components=1
  rm -rf "$work"
fi
ln -sfn "$node_root" "$NODE_DIR"
use_pinned_node
corepack enable

step "gitleaks"
bash "${REPO_DIR}/scripts/install-gitleaks.sh"

step "Caddy"
if [[ "$(dpkg-query -W -f='${Version}' caddy 2>/dev/null || true)" != "${CADDY_VERSION}" ]]; then
  if [[ ! -f /usr/share/keyrings/caddy-stable-archive-keyring.gpg ]]; then
    curl -fsSL --retry 3 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' |
      gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  fi
  curl -fsSL --retry 3 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    >/etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-mark unhold caddy >/dev/null 2>&1 || true
  apt-get install -y -q "caddy=${CADDY_VERSION}"
  apt-mark hold caddy
fi

step "ユーザーとディレクトリ"
if ! id "$FACTORY_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$STATE_DIR" --no-create-home --shell /usr/sbin/nologin \
    --groups docker "$FACTORY_USER"
fi
usermod -aG docker "$FACTORY_USER"
install -d -o root -g root -m 0755 "$ETC_DIR" "$(dirname "$APP_DIR")"
install -d -o "$FACTORY_USER" -g "$FACTORY_USER" -m 0750 "$STATE_DIR"

step "コードの取得"
if [[ ! -d "${APP_DIR}/.git" ]]; then
  git clone --quiet "$FACTORY_REPO_URL" "$APP_DIR"
fi

step "設定と秘密情報"
if [[ ! -f "${ETC_DIR}/factory.toml" ]]; then
  # 初回だけ作る。保存先を StateDirectory に向ける（以後は上書きしない）
  sed -e "s#^database_path = .*#database_path = \"${STATE_DIR}/factory.db\"#" \
    -e "s#^trace_dir = .*#trace_dir = \"${STATE_DIR}/traces\"#" \
    -e "s#^work_dir = .*#work_dir = \"${STATE_DIR}/work\"#" \
    "${APP_DIR}/factory.toml" >"${ETC_DIR}/factory.toml"
  chmod 0644 "${ETC_DIR}/factory.toml"
fi
check_secret_file "${ETC_DIR}/factory.env" "${APP_DIR}/deploy/factory.env.example" "$FACTORY_USER" \
  SAKURA_AI_API_KEY GITHUB_APP_ID GITHUB_APP_PRIVATE_KEY_PATH GITHUB_WEBHOOK_SECRET
# GitHub App の秘密鍵（007）。ファイルの場所は factory.env に書く
app_key="$(grep -E '^GITHUB_APP_PRIVATE_KEY_PATH=' "${ETC_DIR}/factory.env" | cut -d= -f2-)"
[[ -f "$app_key" ]] || die "GitHub App の秘密鍵 ${app_key} がありません（deploy/README.md の GitHub App の章）"
key_owner="$(stat -c '%U:%G %a' "$app_key")"
[[ "$key_owner" == "root:${FACTORY_USER} 640" ]] ||
  die "${app_key} の所有者と権限を root:${FACTORY_USER}・640 にしてください（現在 ${key_owner}）"
check_secret_file /etc/caddy/caddy.env "${APP_DIR}/deploy/caddy.env.example" caddy \
  FACTORY_DOMAIN STAGING_DOMAIN CADDY_TLS STATUS_USER STATUS_PASSWORD_HASH

step "systemd と Caddy"
install -m 0644 "${APP_DIR}/deploy/systemd/factory.service" /etc/systemd/system/factory.service
install -d -m 0755 /etc/systemd/system/caddy.service.d
install -m 0644 "${APP_DIR}/deploy/systemd/caddy.service.d/sakura-factory.conf" \
  /etc/systemd/system/caddy.service.d/sakura-factory.conf
install -m 0644 "${APP_DIR}/deploy/Caddyfile" /etc/caddy/Caddyfile
systemctl daemon-reload
(
  set -a
  # shellcheck source=/dev/null
  source /etc/caddy/caddy.env
  set +a
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
) || die "Caddyfile の検証に失敗しました"
systemctl enable factory caddy docker
systemctl restart caddy

step "ファイアウォールと SSH"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
for port in 22/tcp 80/tcp 443/tcp; do
  ufw allow "$port" >/dev/null
done
ufw --force enable >/dev/null
if [[ "$FACTORY_SKIP_SSH" == "1" ]]; then
  printf 'SSH の設定を飛ばしました（FACTORY_SKIP_SSH=1）\n'
else
  # 締め出しを防ぐため、鍵が1つ以上あるのを確かめてからパスワードでのログインを止める
  if ! cat /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys 2>/dev/null | grep -qE '^(ssh-|ecdsa-|sk-)'; then
    die "authorized_keys に SSH の鍵がありません。鍵でログインできるようにしてから流し直してください"
  fi
  # sshd は同じ設定名なら先に読んだ値を使い、sshd_config.d は名前順に読む。
  # cloud-init のイメージには 50-cloud-init.conf（PasswordAuthentication yes）があるので、それより先に読まれる名前にする
  rm -f /etc/ssh/sshd_config.d/50-sakura-factory.conf
  cat >/etc/ssh/sshd_config.d/01-sakura-factory.conf <<'CONF'
# setup.sh（006）が置く。パスワードでのログインを止める。
# 名前順で最初に読まれるよう 01- にする（sshd は先に読んだ値を使う）
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
CONF
  sshd -t || die "sshd の設定の検証に失敗しました"
  # ほかの設定ファイルに負けていないか、実際に効く値で確かめる
  effective="$(sshd -T 2>/dev/null)"
  # prohibit-password は sshd -T では旧名の without-password で出る版がある
  for expected in 'passwordauthentication no' 'kbdinteractiveauthentication no' \
    'permitrootlogin (prohibit-password|without-password)'; do
    grep -qxE "$expected" <<<"$effective" ||
      die "sshd の実際の設定が「${expected}」になりません（/etc/ssh/sshd_config と sshd_config.d を確かめてください）"
  done
  systemctl reload ssh
fi

step "更新"
bash "${APP_DIR}/deploy/scripts/update.sh" "$FACTORY_REF"

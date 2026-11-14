#!/usr/bin/env bash
# 配備の予行演習（pnpm run deploy:rehearsal）。systemd 付きの Ubuntu 24.04 のコンテナに、
# 本番と同じ setup.sh を流して、Caddy 経由の生存確認まで確かめる。終わったら（成功・失敗とも）片付ける。
# 仕様: specs/006-vps-ops/quickstart.md 4章、research.md R13
#
# 環境変数:
#   REHEARSAL_KEEP=1        終わっても片付けない（調べるとき用。あとで docker rm -f sakura-factory-rehearsal）
#   REHEARSAL_EXTRA_CA=path コンテナに追加で信頼させる CA（TLS を差し替えるプロキシの中で流すとき用）
set -euo pipefail

cd "$(dirname "$0")/../.."

LABEL="sakura-factory.rehearsal=1"
IMAGE="sakura-factory-rehearsal:latest"
NAME="sakura-factory-rehearsal"
VOLUME="sakura-factory-rehearsal-docker"
VOLUME_CONTAINERD="sakura-factory-rehearsal-containerd"
APP_DIR="/opt/sakura-factory/app"
STARTED_AT="$(date +%s)"
failures=0

remove_all() {
  docker ps -aq --filter "label=${LABEL}" | xargs -r docker rm -f >/dev/null
  docker volume ls -q --filter "label=${LABEL}" | xargs -r docker volume rm >/dev/null
}

cleanup() {
  rm -rf "${work:-}"
  if [[ "${REHEARSAL_KEEP:-0}" == "1" ]]; then
    printf '片付けを飛ばしました（REHEARSAL_KEEP=1）\n'
    return
  fi
  remove_all
}
trap cleanup EXIT

in_box() { docker exec "$NAME" bash -c "$1"; }

# /status の Basic 認証（011）の予行演習用のパスワード（箱の中だけで使う）
STATUS_PASSWORD="rehearsal-status-pass"

check() {
  local number="$1" title="$2" command="$3"
  if output="$(in_box "$command" 2>&1)"; then
    printf 'ok   %2s %s\n' "$number" "$title"
  else
    printf 'NG   %2s %s\n%s\n' "$number" "$title" "$output" >&2
    failures=$((failures + 1))
  fi
}

if [[ -n "$(git status --porcelain)" ]]; then
  printf '注意: コミットしていない変更は予行演習に入りません（HEAD のコミットを流します）\n' >&2
fi
commit="$(git rev-parse HEAD)"

printf '==> 予行演習のイメージ\n'
docker build --quiet -t "$IMAGE" deploy/rehearsal >/dev/null

printf '==> コンテナの起動\n'
# 前回 REHEARSAL_KEEP=1 で残したものがあれば消してから始める
remove_all
work="$(mktemp -d)"
git bundle create --quiet "${work}/factory.bundle" HEAD
docker volume create --label "$LABEL" "$VOLUME" >/dev/null
docker volume create --label "$LABEL" "$VOLUME_CONTAINERD" >/dev/null
# systemd を PID 1 で動かし、中で Docker（作業場のイメージのビルド）も動かすので特権付きにする（ローカルでだけ使う）。
# 中の Docker のデータはボリュームに置く（コンテナの overlay の上に overlay は重ねられない。
# Docker 29 は containerd のイメージストアを使うので /var/lib/containerd も要る）
docker run -d --name "$NAME" --label "$LABEL" --privileged --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock \
  -v "${VOLUME}:/var/lib/docker" -v "${VOLUME_CONTAINERD}:/var/lib/containerd" "$IMAGE" >/dev/null
for _ in $(seq 1 30); do
  state="$(in_box 'systemctl is-system-running' 2>/dev/null || true)"
  [[ "$state" == "running" || "$state" == "degraded" ]] && break
  sleep 1
done
[[ "$state" == "running" || "$state" == "degraded" ]] || {
  printf 'ERROR: コンテナの systemd が起動しません（%s）\n' "$state" >&2
  exit 1
}

if [[ -n "${REHEARSAL_EXTRA_CA:-}" ]]; then
  docker cp "$REHEARSAL_EXTRA_CA" "${NAME}:/usr/local/share/ca-certificates/rehearsal-extra.crt"
  in_box 'update-ca-certificates >/dev/null'
fi

printf '==> リポジトリの取得（手順書の2章。取得元は HEAD の bundle）\n'
docker cp "${work}/factory.bundle" "${NAME}:/tmp/factory.bundle"
in_box "git -c advice.detachedHead=false clone --quiet /tmp/factory.bundle ${APP_DIR} && git -C ${APP_DIR} checkout --quiet --detach ${commit}"

setup="FACTORY_REPO_URL=/tmp/factory.bundle FACTORY_REF=${commit} FACTORY_SKIP_SSH=1 ${APP_DIR}/deploy/scripts/setup.sh"

printf '==> 確認\n'
# 1: 秘密情報のファイルがなければ、ひな形を置いて止まる
check 1 "setup.sh の1回目はひな形を置いて止まる" \
  "! ${setup} >/tmp/setup1.log 2>&1 && grep -q 'factory.env を作りました' /tmp/setup1.log && test -f /etc/sakura-factory/factory.env"

# 偽の値を書く（予行演習なので本物の値は使わない。起動時に LLM は呼ばない）
in_box "sed -i -e 's/^SAKURA_AI_API_KEY=.*/SAKURA_AI_API_KEY=rehearsal-dummy/' -e 's/^GITHUB_APP_ID=.*/GITHUB_APP_ID=1/' -e 's/^GITHUB_WEBHOOK_SECRET=.*/GITHUB_WEBHOOK_SECRET=rehearsal-dummy-secret/' /etc/sakura-factory/factory.env"
# 偽の GitHub App の秘密鍵（起動時には解析しない。GitHub を呼ぶのはジョブを処理するときだけ）
in_box "printf '%s\\n' '-----BEGIN RSA PRIVATE KEY-----' 'rehearsal-dummy' '-----END RSA PRIVATE KEY-----' >/etc/sakura-factory/github-app.pem && chown root:factory /etc/sakura-factory/github-app.pem && chmod 0640 /etc/sakura-factory/github-app.pem"
in_box "${setup} >/tmp/setup1b.log 2>&1 || true"
in_box "sed -i -e 's/^FACTORY_DOMAIN=.*/FACTORY_DOMAIN=factory.test/' -e 's/^STAGING_DOMAIN=.*/STAGING_DOMAIN=staging.test/' -e 's/^CADDY_TLS=.*/CADDY_TLS=internal/' /etc/caddy/caddy.env"
# /status の Basic 認証（011）。ハッシュは箱の中の caddy で作り、本番と同じく単一引用符で囲んで書く
in_box "hash=\$(caddy hash-password --plaintext ${STATUS_PASSWORD}) && sed -i -e '/^STATUS_USER=/d' -e '/^STATUS_PASSWORD_HASH=/d' /etc/caddy/caddy.env && printf 'STATUS_USER=rehearsal\nSTATUS_PASSWORD_HASH='\''%s'\''\n' \"\$hash\" >>/etc/caddy/caddy.env"

# 2: 値を書いて流し直すと最後まで通る
if in_box "${setup} >/tmp/setup2.log 2>&1"; then
  printf 'ok    2 setup.sh の2回目が通る\n'
else
  in_box 'tail -40 /tmp/setup2.log' >&2 || true
  printf 'NG    2 setup.sh の2回目が通る（以降の確認は飛ばします）\n' >&2
  exit 1
fi
check 2b "最後に deployed <HEAD> を出す" "grep -q 'deployed ${commit}' /tmp/setup2.log"

# 仮のステージングのアプリ（010 のデモアプリの代わり）
in_box "mkdir -p /srv/staging && echo 'staging ok' >/srv/staging/index.html && systemd-run --unit=staging-dummy --working-directory=/srv/staging python3 -m http.server 3100 --bind 127.0.0.1 >/dev/null"
sleep 1

curl_factory="curl -sk --resolve factory.test:443:127.0.0.1"
curl_staging="curl -sk --resolve staging.test:443:127.0.0.1"
check 3 "factory・caddy・docker が active" "systemctl is-active factory caddy docker"
check 4 "Caddy 経由の /healthz" "${curl_factory} https://factory.test/healthz | grep -qx '{\"status\":\"ok\"}'"
check 5 "公開していないパスは Caddy が 404" "test \"\$(${curl_factory} -o /dev/null -w '%{http_code}' https://factory.test/other)\" = 404"
check 6 "ステージングに転送する" "${curl_staging} https://staging.test/ | grep -q 'staging ok'"
in_box 'systemctl stop staging-dummy'
check 7 "ステージングが止まると 502、ファクトリーは 200 のまま" \
  "test \"\$(${curl_staging} -o /dev/null -w '%{http_code}' https://staging.test/)\" = 502 && test \"\$(${curl_factory} -o /dev/null -w '%{http_code}' https://factory.test/healthz)\" = 200"
check 7b "/status は認証なしで 401（ファクトリーに届かない）" \
  "test \"\$(${curl_factory} -o /dev/null -w '%{http_code}' https://factory.test/status)\" = 401"
check 7c "/status は誤ったパスワードで 401" \
  "test \"\$(${curl_factory} -u rehearsal:wrong -o /dev/null -w '%{http_code}' https://factory.test/status)\" = 401"
check 7d "/status は正しい認証で 200 と HTML、JSON も返る" \
  "${curl_factory} -u rehearsal:${STATUS_PASSWORD} https://factory.test/status | grep -q 'ソフトウェアファクトリーの状況' && ${curl_factory} -u rehearsal:${STATUS_PASSWORD} 'https://factory.test/status?format=json' | python3 -c 'import json,sys; json.load(sys.stdin)[\"consumption\"]'"
check 8 "HTTP は HTTPS に 308 で転送" \
  "curl -si --resolve factory.test:80:127.0.0.1 http://factory.test/healthz | grep -qE '^HTTP/1.1 308' && curl -si --resolve factory.test:80:127.0.0.1 http://factory.test/healthz | grep -qi '^location: https://'"
check 9 "秘密情報のファイルは root:factory 640" "test \"\$(stat -c '%U:%G %a' /etc/sakura-factory/factory.env)\" = 'root:factory 640'"
check 9b "データの置き場所と DB は factory だけが読める" \
  "test \"\$(stat -c '%U %a' /var/lib/sakura-factory)\" = 'factory 750' && test \"\$(stat -c '%a' /var/lib/sakura-factory/factory.db)\" = 640"
check 9c "作業ディレクトリ（007）は StateDirectory の下" \
  "grep -q '^work_dir = \"/var/lib/sakura-factory/work\"' /etc/sakura-factory/factory.toml"
check 10 "強制終了から 30 秒以内に自動で再起動する" \
  "before=\$(systemctl show -p MainPID --value factory); kill -9 \$before; for i in \$(seq 1 30); do sleep 1; after=\$(systemctl show -p MainPID --value factory); if [ \"\$after\" != 0 ] && [ \"\$after\" != \"\$before\" ] && ${curl_factory} https://factory.test/healthz | grep -q ok; then exit 0; fi; done; exit 1"
check 11 "journald から JSON のログを読める" "journalctl -u factory -o cat -n 1 --no-pager | python3 -c 'import json,sys; json.loads(sys.stdin.readline())'"
check 12 "2回目の setup.sh でも DB の中身が変わらない" \
  "a=\$(sqlite3 /var/lib/sakura-factory/factory.db .dump | sha256sum); ${setup} >/tmp/setup3.log 2>&1 && b=\$(sqlite3 /var/lib/sakura-factory/factory.db .dump | sha256sum) && test \"\$a\" = \"\$b\""
check 13 "ufw は 22・80・443 だけ" \
  "ufw status | grep -E 'ALLOW' | awk '{print \$1}' | sort -u | tr '\n' ' ' | grep -qx '22/tcp 443/tcp 80/tcp '"
check 14 "動いている版が HEAD と同じ" "test \"\$(git -C ${APP_DIR} rev-parse HEAD)\" = ${commit}"
check 15 "gitleaks の版" "gitleaks version | grep -q 8.30.1"
check 16 "/healthz が 100ms 以内" \
  "${curl_factory} -o /dev/null https://factory.test/healthz; for i in \$(seq 1 10); do t=\$(${curl_factory} -o /dev/null -w '%{time_total}' https://factory.test/healthz); python3 -c \"import sys; sys.exit(0 if float('\$t') <= 0.1 else 1)\" || exit 1; done"

elapsed=$(($(date +%s) - STARTED_AT))
printf '17 全体の所要時間: %d 秒（15 分以内: %s）\n' "$elapsed" "$([[ $elapsed -le 900 ]] && echo ok || echo NG)"
[[ $elapsed -le 900 ]] || failures=$((failures + 1))

if [[ "$failures" -gt 0 ]]; then
  printf '予行演習: %d 件の確認が通りませんでした\n' "$failures" >&2
  exit 1
fi
printf '予行演習: すべて通りました\n'

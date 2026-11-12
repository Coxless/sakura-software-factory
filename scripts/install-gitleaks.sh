#!/usr/bin/env bash
# gitleaks を固定した版で /usr/local/bin に入れる。Workshop（setup-project）・CI・VPS（setup.sh）の3か所から呼ぶ。
# 版とチェックサムを持つのはこのファイルだけ（specs/006-vps-ops/research.md R10）。
# 同じ版が入っていれば何もしない。チェックサムが一致しなければ入れずに失敗する。
set -euo pipefail

GITLEAKS_VERSION="8.30.1"
# 公式の gitleaks_${GITLEAKS_VERSION}_checksums.txt から写す
# （https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_checksums.txt）
GITLEAKS_SHA256_linux_x64="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
GITLEAKS_SHA256_linux_arm64="e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080"

INSTALL_PATH="/usr/local/bin/gitleaks"

fail() {
  printf 'ERROR: gitleaks のインストールに失敗しました: %s\n' "$1" >&2
  exit 1
}

case "$(uname -m)" in
  x86_64) arch="x64"; expected="$GITLEAKS_SHA256_linux_x64" ;;
  aarch64 | arm64) arch="arm64"; expected="$GITLEAKS_SHA256_linux_arm64" ;;
  *) fail "対応していないアーキテクチャです: $(uname -m)" ;;
esac

if [[ -x "$INSTALL_PATH" ]] && [[ "$("$INSTALL_PATH" version 2>/dev/null)" == *"$GITLEAKS_VERSION"* ]]; then
  printf 'gitleaks %s は入っています\n' "$GITLEAKS_VERSION"
  exit 0
fi

if [[ -z "$expected" ]]; then
  fail "linux_${arch} のチェックサムが未設定です。scripts/install-gitleaks.sh に公式の checksums.txt の値を書いてください"
fi

tarball="gitleaks_${GITLEAKS_VERSION}_linux_${arch}.tar.gz"
url="https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${tarball}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

curl -fsSL --retry 3 -o "${work}/${tarball}" "$url" || fail "ダウンロードできません: ${url}"
printf '%s  %s\n' "$expected" "${work}/${tarball}" | sha256sum -c --quiet - ||
  fail "チェックサムが一致しません（${tarball}）。入れずに止めます"
tar -xzf "${work}/${tarball}" -C "$work" gitleaks

if [[ "$(id -u)" -eq 0 ]]; then
  install -m 0755 "${work}/gitleaks" "$INSTALL_PATH"
else
  sudo install -m 0755 "${work}/gitleaks" "$INSTALL_PATH"
fi
printf 'gitleaks %s を %s に入れました\n' "$GITLEAKS_VERSION" "$INSTALL_PATH"

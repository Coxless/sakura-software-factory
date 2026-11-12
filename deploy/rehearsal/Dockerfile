# 予行演習用の Ubuntu 24.04（systemd を PID 1 で動かす）。pnpm run deploy:rehearsal が使う
# 本番の VPS の代わりなので、配備スクリプトが入れるもの（Docker・Caddy・Node など）はここで入れない
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    systemd systemd-sysv dbus iproute2 iptables python3 curl ca-certificates git sudo openssh-server \
  && rm -rf /var/lib/apt/lists/* \
  # コンテナでは動かない・要らないユニットを止める
  && systemctl mask systemd-logind.service getty@.service console-getty.service systemd-udevd.service \
    systemd-firstboot.service systemd-remount-fs.service

LABEL sakura-factory.rehearsal="1"
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]

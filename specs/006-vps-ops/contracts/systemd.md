# Contract: systemd（006）

## `deploy/systemd/factory.service`

```ini
[Unit]
Description=Sakura Software Factory
Wants=network-online.target
After=network-online.target docker.service
Requires=docker.service
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
User=factory
Group=factory
SupplementaryGroups=docker
WorkingDirectory=/opt/sakura-factory/app
Environment=FACTORY_CONFIG=/etc/sakura-factory/factory.toml
Environment=NODE_ENV=production
EnvironmentFile=/etc/sakura-factory/factory.env
ExecStart=/opt/node/bin/node src/main.ts
Restart=on-failure
RestartSec=5
TimeoutStopSec=20
StateDirectory=sakura-factory
StateDirectoryMode=0750
UMask=0027
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes

[Install]
WantedBy=multi-user.target
```

| 要件 | 設定 |
|---|---|
| 専用の非 root ユーザー（FR-008） | `User=factory`。`factory` はログインできないシステムユーザー（`/usr/sbin/nologin`） |
| 自動再起動と上限（FR-008、SC-003） | `Restart=on-failure`・`RestartSec=5`・5 分に 5 回まで |
| Docker とネットワークのあと（FR-009） | `After=`・`Requires=docker.service`、`network-online.target` |
| 秘密情報（FR-010） | `EnvironmentFile=`（`root:factory`、`0640`）。ユニットに値を書かない |
| 保護設定（FR-011） | `ProtectSystem=strict` で書き込みは `StateDirectory`（`/var/lib/sakura-factory`）だけ。Docker のソケットは `SupplementaryGroups=docker` で使う |
| ログ（FR-012） | 標準出力（pino の JSON）を journald へ。`journalctl -u factory -o cat` で JSON を読める |
| 停止（SC-004） | `TimeoutStopSec=20` は `[http] shutdown_timeout_seconds` の上限 10 より長い |

- `PrivateTmp=yes` の `/tmp` は Docker デーモンから見えない。作業場に bind mount する作業ディレクトリは `/var/lib/sakura-factory` の下に置く（007）
- `MemoryDenyWriteExecute` は Node の JIT と両立しないので使わない
- `ProtectSystem=strict` でも Docker への接続はソケット経由なので妨げない。実装のときに予行演習で確かめる

## `deploy/systemd/caddy.service.d/sakura-factory.conf`

```ini
[Service]
EnvironmentFile=/etc/caddy/caddy.env
```

- Caddy の apt パッケージが入れる `caddy.service` に、ドメインと TLS の環境変数を渡す drop-in。`/etc/systemd/system/caddy.service.d/` に写す

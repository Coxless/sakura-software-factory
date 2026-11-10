# Contract: 4ツール

実装役（004）に渡すツールの名前・引数・結果。パスはすべて作業ディレクトリ（コンテナ内の `/workspace`）からの相対パスか、`/workspace/` で始まる絶対パス。

結果の `content` は文字列1つ。誤用・拒否・作業場の異常は `isError: true` で返し、例外にしない（FR-015）。

## `read_file`

| 引数 | 型 | 必須 | 説明 |
|---|---|---|---|
| `path` | string | ✅ | 読むファイル |
| `offset` | integer ≥ 1 | | 開始行（既定 1） |
| `limit` | integer ≥ 1 | | 行数（既定・最大は `tools.read_max_lines`） |

成功時の `content`（`cat -n` と同じ形。1行が 2,000 文字を超えたら切り詰める）:

```
     1	import { x } from "./x.ts";
     2	
     3	export const y = x + 1;
```

続きがあるときは末尾に `（120行中 1〜100行目。続きは offset: 101 で読めます）`。バイナリ（先頭 8 KiB に NUL を含む）は `バイナリファイルです（12345 バイト）。内容は返しません` だけを返す。空のファイルは `（空のファイルです）`。

## `write_file`

| 引数 | 型 | 必須 | 説明 |
|---|---|---|---|
| `path` | string | ✅ | 書くファイル。途中のディレクトリがなければ作る |
| `content` | string | ✅ | 内容（ファイル全体を置き換える。空文字可） |

成功時: `src/a.ts に書き込みました（新規、120 バイト）` または `（上書き、…）`。

## `edit_file`

| 引数 | 型 | 必須 | 説明 |
|---|---|---|---|
| `path` | string | ✅ | 対象のファイル |
| `old_string` | string（1文字以上） | ✅ | 置換元。前後の行も含めて一意になるように書く |
| `new_string` | string | ✅ | 置換先 |
| `replace_all` | boolean | | true ならすべての出現を置き換える（既定 false） |

ファイルが CRLF で、`old_string` / `new_string` が LF だけなら、CRLF に直してから照合・置換する。

成功時: `src/a.ts を編集しました（1か所）`。

## `bash`

| 引数 | 型 | 必須 | 説明 |
|---|---|---|---|
| `command` | string（1文字以上） | ✅ | `bash -c` で実行するコマンド。作業ディレクトリで実行する |
| `timeout_seconds` | integer ≥ 1 | | 時間の上限（既定 `tools.bash_timeout_seconds`、最大 `tools.bash_max_timeout_seconds`。超える値は最大に丸める） |

結果の `content`（0 以外の終了コードも `isError: false`）:

```
exit_code: 1
--- stdout ---
…
--- stderr ---
…
```

時間切れのときは先頭に `時間の上限（120秒）を超えたため打ち切りました。` を足し、`isError: true`。出力が空の欄は `（なし）`。ネットワークはないこと、依存は準備工程で入っていることをツールの説明に書く。

## エラーの文面

| 種類（`details.error`） | 文面の例 |
|---|---|
| `invalid_args` | `引数が正しくありません: /path: 必須の項目がありません` |
| `not_found` | `ファイルがありません: src/x.ts` |
| `is_directory` | `ディレクトリです: src。ファイルのパスを指定してください（中身は bash の ls で確かめられます）` |
| `outside_workspace` | `作業ディレクトリの外は扱えません: ../etc/passwd（作業ディレクトリからの相対パスで指定してください）` |
| `no_match` | `old_string が src/a.ts に見つかりません。read_file で現在の内容を確かめてください` |
| `multiple_matches` | `old_string が src/a.ts に 3 か所あります。前後の行を含めて一意にするか、replace_all: true を指定してください` |
| `no_change` | `old_string と new_string が同じです` |
| `sandbox_unavailable` | `作業場が使えません（コンテナが停止しています）: <docker のエラー>` |

## 検査（層3）で拒否したときの文面

拒否の結果は Pi が `isError: true` のツール結果にしてモデルに返す（004）。`reason` の例:

| 検査 | 例 |
|---|---|
| `path` | `作業ディレクトリの外は扱えません: /etc/passwd` |
| `path`（禁止パス） | `.github/workflows/ci.yml は書き換えが禁止されています（一致した規則: .github/workflows/**）。CI の定義・環境変数ファイル・ロックファイル・デプロイ設定・.git は変更できません` |
| `path`（リンク経由） | `ci.yml の実際のパスは .github/workflows/ci.yml で、書き換えが禁止されています（一致した規則: .github/workflows/**）` |
| `command` | `このコマンドは実行できません（理由: リモートへの push。git push はファクトリーが行います）` |

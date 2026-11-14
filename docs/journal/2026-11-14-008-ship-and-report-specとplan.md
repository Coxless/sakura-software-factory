# 008 ship-and-report の spec と plan

判定に合格したジョブを PR にする工程（出荷前チェック・commit・push・PR・auto-merge か Draft か・まとめレポート）の spec と plan を書いた。ユーザーの指示で、判断が要るところはいったん推奨の回答で決めた。

## 推奨の回答で決めたこと

| 問い | 決めたこと | 理由 |
|---|---|---|
| 秘密情報が見つかったら Draft か、push しないか | push しない（`failed`） | Draft でも push した時点でリモートに残る。テスト用のリポジトリは public |
| `.github/workflows` を変えた diff | push しない（`failed`） | App に Workflows の権限がないので、GitHub が push を拒否する |
| PR を作ったらジョブはどこで止まるか | `ci_waiting` に進め、Worker は次へ | `03` 3章の「`ci_waiting` はワーカーを占有しない」。CI の結果は 009 |
| まとめレポートの書き先 | PR の本文。Issue には PR へのリンクを1回 | 009・010 で書き足す先を1か所にする |
| PR で Issue を閉じるか | 閉じない（`Refs #n`） | マージ後にステージングで戻すことがある（010） |

## gitleaks は終了コードだけでは安全側に倒せない

出荷前チェックの秘密情報のスキャンに 006 で入れた gitleaks（8.30.1）を使う。Workshop で一時リポジトリを作り、本物の形のトークン（`ghp_` と 36 文字の乱数）を commit して挙動を確かめた。

```
gitleaks git --no-banner --redact --log-opts="<base>..HEAD" --exit-code 3 --report-format json --report-path - .
```

| 試したこと | 結果 |
|---|---|
| `--config` なし | `[('leak.js', 1, 'github-pat')]`、exit=3 |
| 同じ範囲に、`leak.js` を許可する `.gitleaks.toml` を足す commit を加えた | 0 件、exit=0（作業ツリーの `.gitleaks.toml` を自動で読む） |
| `--config` で既定の規則だけの設定を渡す | 1 件、exit=3 |
| 行末に `// gitleaks:allow` を付けたトークン | 報告されない |
| `--log-opts="nonexist..HEAD"`（範囲の誤り） | `ERR [git] fatal: ambiguous argument 'nonexist..HEAD'` のあと `0 commits scanned` `no leaks found`、**exit=0** |
| `--log-opts="HEAD..HEAD"`（範囲が空） | `0 commits scanned`、exit=0 |
| 壊れた設定ファイル | `FTL unable to load gitleaks config`、exit=1 |

分かったこと:

- エージェントは同じ変更で `.gitleaks.toml`・`.gitleaksignore` を足したり、行末に `gitleaks:allow` を書いたりして、スキャンをすり抜けられる
- 範囲を誤ると、エラーを出しつつ終了コード 0（検出なし）になる。終了コードだけを見ると push してしまう

決めたこと（research R4）:

- 設定は基準のコミット（clone した既定のブランチ）の `.gitleaks.toml`・`.gitleaksignore` を一時ファイルに書き出して `--config`・`--gitleaks-ignore-path` で渡す。基準になければ既定の規則だけ
- 追加行に `gitleaks:allow` があれば、見つかったものとして扱う
- 「見つからない」と判断するのは、終了コード 0 かつ標準エラーに `1 commits scanned` があり、`ERR`・`FTL` の行がないときだけ。それ以外はスキャンできなかったとして push しない
- `.gitleaks.toml`・`.gitleaksignore` を既定の禁止パスに足す（変えると CI の秘密情報スキャンの許可が変わるので Draft にする）

## AI解禁の前に出荷を本物の GitHub で試す方法

常駐のファクトリーは さくら以外の提供元では起動しない（原則 I）ので、AI解禁の前は判定まで進められない。常駐のファクトリーに偽の工程を差し込む切り替えを足すと本番で誤って有効にする余地が残るので、開発用の CLI `pnpm run ship:dev` を別に作ることにした（パッチを当てて、偽の「合格」の結果で `shipJob` だけを呼ぶ）。

## まだ分かっていないこと

- テスト用のリポジトリ（public・GitHub Free）で、`enablePullRequestAutoMerge` がブランチ保護なしのときに返すエラーの文
- 無料プランの非公開リポジトリで Draft PR を作ったときの `422` の文（Draft を作れないときの判定に使う）

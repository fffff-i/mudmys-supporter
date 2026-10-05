# 開発とGit運用

このプロジェクトはTrunk-Based Developmentで開発します。唯一の長期ブランチは `main` です。常にテストとビルドを通し、配布できる状態を保ちます。

## 作業の単位

- `main` から目的が1つの短命ブランチ `codex/<変更内容>` を作ります。通常は当日中、長くても2営業日以内に統合できる大きさに分けます。
- 継続的な `develop` や機能ごとの長期ブランチは作りません。大きな機能は互換性を保つ小さなPRへ分け、未完成部分は利用者へ公開しないフラグなどで隠します。
- PRの統合先は `main` です。最新のmainでCIを成功させ、squash mergeします。統合したリモートブランチはGitHubが自動削除します。
- CI失敗時は新しい統合より修正を優先し、速やかに修正PRまたは原因変更のrevert PRを作ります。mainをforce pushして履歴を書き換えません。

## 初回設定

開発・CIの標準はNode.js 24とnpmです。`.nvmrc` のバージョンを使い、ロックファイルから依存関係を導入します。

```powershell
npm ci
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setupTrunk.ps1
```

このスクリプトは、このクローンだけに `pull.ff=only`、`merge.ff=only`、`fetch.prune=true`、`push.default=simple`、`push.autoSetupRemote=true` を設定します。グローバル設定は変更しません。`ExecutionPolicy Bypass` はこのPowerShellプロセスだけに適用し、Windowsの実行ポリシーを変更しません。

## 日々の開発

未コミットの作業を保管し、次の手順で最新のmainから開始します。

```powershell
git switch main
git pull --ff-only origin main
git switch -c codex/describe-the-change
```

実装後は、後述の検証を実行し、変更したファイルを明示してstageします。commit・push前にファイル一覧と差分を確認します。

```powershell
npm run check
git add <変更したファイル>
git diff --cached --name-only
git diff --cached
git commit -m "変更の目的を説明する"
git push -u origin codex/describe-the-change
```

mainを宛先とするPRを作り、変更後の動作と検証結果を記載します。mainが進んだ場合はGitHubの「Update branch」で最新のmainを取り込み、必須CI `Verify` の成功を待ちます。GitHubはPRの統合結果も検証します。Merge Queueを有効にできる環境ではPRを待機列へ入れ、`merge_group` のCI成功後に統合します。PR・main・待機列にはパスによるCIの省略を設定せず、文書だけの変更でも同じチェックを実行します。

squash merge後はローカルmainを更新します。

```powershell
git switch main
git pull --ff-only origin main
git fetch --prune origin
```

PRの統合済み状態と未保存の作業がないことを確認し、ローカルの作業ブランチを削除します。squash mergeはコミットIDが変わるため、この確認後に `git branch -D codex/describe-the-change` を使います。mainへの直接pushは使いません。

## 検証

`npm run check` は単体テスト、型検査、ビルド、6種類のヘッドレス画面検証を順に実行します。画面検証にはEdge / Chrome / Chromiumが必要です。標準位置にない場合は `MAKUA_HEADLESS_BROWSER` に実行ファイルのパスを指定します。画面検証だけを再実行する場合は、ビルド後に `npm run test:ui` を使います。

個別の画面検証は、ビルド後に次のスクリプトを実行します。各スクリプトは架空データ、モック、固有のブラウザープロファイルを使い、実際のAI送信やユーザーデータを検証に使いません。

| コマンド | 検証する動作 | 結果の保存先 |
| --- | --- | --- |
| `node scripts/verifyScenarioDrafts.cjs` | シナリオ切替、保存中の下書きと追加入力 | `.local/scenario-drafts-ui/` |
| `node scripts/verifyPdfSources.cjs` | PDF原本、ページ別出典、旧データ、失敗・遅延応答 | `.local/pdf-sources-ui/` |
| `node scripts/verifyActionHistory.cjs` | 1クリック完了・見送り、任意メモ、切替中の保存 | `.local/action-history-ui/` |
| `node scripts/verifyEvidenceIntake.cjs` | 一括追加、Ctrl+Enter・IME、編集、除外・復帰 | `.local/evidence-intake-ui/` |
| `node scripts/verifyAnalysisUpdates.cjs` | 解析中の保存、更新集約、取消、古い応答の排除 | `.local/analysis-update-ui/` |
| `node scripts/verifyPlayScreen.cjs` | 主画面での追加、全件展開、保存時の出典、画面配置 | `.local/play-screen-ui/` |

結果JSON・画像・ブラウザープロファイルなどの生成物はGit対象外です。

## 公開文書とローカル情報

Git上の文書は、各クローンで共通のプロジェクト情報に限定します。

| 文書 | 役割 |
| --- | --- |
| [README.md](README.md) | アプリの機能、利用方法、AIへの送信範囲と保存の仕様 |
| [AGENTS.md](AGENTS.md) | coding agentが守るプロジェクト共通の規則 |
| CONTRIBUTING.md | 開発環境、検証、Git・並行開発・リリースの手順 |
| [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md) | 変更後の動作と検証結果を確認するPR様式 |

PC固有の操作制約、個人の絶対パス、タスクの引き継ぎ、会話履歴、調査ログ、実資料、認証情報はGit管理外で扱います。作業記録は `.local/` に保存できます。プロジェクト固有のローカル指示には、Git対象外のルート `AGENTS.override.md` を使えます。個人の共通指示は、Git管理外のCodexホームの `AGENTS.md` で管理できます。

Codexは同じディレクトリでは `AGENTS.override.md` を `AGENTS.md` より優先し、両方を自動結合しません。ローカルoverrideの冒頭には、公開 `AGENTS.md` を先に読んで共通規則を適用する指示を記載してください。未追跡のローカル指示は新しいworktreeへ自動的には引き継がれないため、必要なworktreeに個別に配置します。[公式の読み込み順序](https://learn.chatgpt.com/docs/agent-configuration/agents-md)

ローカル情報を公開文書・PR本文・コミットメッセージ・コメントへ転記しないよう、commit・push前に確認します。CIとPRレビューはpush後に動くため、公開前の確認を代替しません。`.gitignore`への追加やファイルの削除だけでは、公開済みのコミット・PRから内容は消えません。

## Codexへ並行開発を委託する場合

Issueを作業単位とし、TBDの短命ブランチを維持して1タスク・1worktree・1PRで分離します。mainが各agentの共有状態の同期点です。大きなIssueは複数の小さなPRへ分けます。Codexのworktreeは [OpenAI公式ドキュメント](https://learn.chatgpt.com/docs/environments/git-worktrees) のとおり、同じリポジトリの複数ブランチを独立した作業ディレクトリで扱えます。全員が同じ作業ディレクトリでブランチを切り替える運用は使いません。

- **取り込み担当:** タスクの受け入れ条件、編集担当、依存関係と統合順を決め、PRのレビュー・mainへの統合・リリースを管理します。mainの作業コピーを開発担当へ共用させません。
- **開発担当:** 最新のmainから専用worktreeと `codex/<タスク>` ブランチを使い、担当範囲で実装・テスト・PR作成を行います。他担当のブランチやmainへ直接コミットしません。
- **重なる変更:** `src/App.tsx`、`src/types.ts`、`electron/main.cjs`、`package.json`、`package-lock.json` などの共有箇所は、同時に編集する担当を1つにします。型・IPC・保存形式の変更は、小さな互換性のあるPRとして先に統合し、利用側は更新後のmainから開始または同期します。
- **統合時:** 取り込み担当は最新mainとの組み合わせで `Verify` が成功したPRを順番に統合します。先のPRが統合されたら後続PRを最新mainへ更新し、CIを再実行します。完了まで溜めて一括統合せず、独立した変更から早く取り込みます。
- **終了時:** 統合済みの短命ブランチを削除し、必要な未追跡ファイル・ログを保管してからworktreeを終了・アーカイブします。各worktreeの依存関係・ビルド出力・テストデータも分離します。

例えば、UI変更とPDF処理変更は専用worktreeで同時に進められます。両方が同じ型定義を必要とする場合は、型定義のPRを先に統合してから両方をそのmainへ合わせます。作業を依頼する際は「目的・編集範囲・依存PR・受け入れ条件・検証コマンド」を渡します。

## GitHub側の設定

設定の原本は [`.github/trunk-settings.json`](.github/trunk-settings.json) です。`main` を既定ブランチとし、squash mergeだけを許可します。Auto-mergeと「Update branch」を利用でき、取り込み後のブランチを自動削除します。

mainの保護は管理者にも適用し、管理者のbypassを許可しません。直接pushを禁止し、PR経由の統合、最新mainに対するGitHub Actionsの `Verify`（App ID: 15368）の成功、会話の解決、直線的な履歴を必須にします。force pushとmainの削除も禁止します。単独開発でも統合できるよう、人間の承認数は0にしています。レビュー担当がいる場合はPRでレビューを依頼できます。

Merge Queueは [GitHubの利用条件](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue) により、組織所有の公開リポジトリ、またはGitHub Enterprise Cloudの組織所有の非公開リポジトリで利用できます。現在の `fffff-i/mudmys-supporter` は個人所有なので、Queue自体は有効化できません。CIの `merge_group` トリガーと、bypassなし・squash・全件チェック成功を要求するQueueルールの原本は準備済みです。組織へ移管した場合は、設定原本の `repository` とoriginを移管先へ変更し、次のスクリプトでQueueも適用します。

リポジトリ管理者が設定を再適用する場合は、Git credential helperでGitHubへ認証済みの環境で次を実行します。認証情報は表示・ファイル保存しません。必須チェックを先に実行できるよう、CIワークフローがリポジトリへpushされた状態で適用してください。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setupTrunk.ps1 -ApplyGitHubSettings
```

## リリース

配布するバージョンはCIが成功したmainのコミットから選び、`package.json` と `package-lock.json` のバージョン変更も通常のPRで統合します。配布版には `v<バージョン>` のタグを付け、そのコミットから `npm run package:portable` を実行します。恒久的なリリースブランチは作りません。配布物はGit管理対象外です。

## 参考

- [Trunk Based Development](https://trunkbaseddevelopment.com/)
- [GitHub: protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)

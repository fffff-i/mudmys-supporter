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

このスクリプトは、このクローンだけに `pull.ff=only`、`merge.ff=only`、`fetch.prune=true`、`push.default=simple`、`push.autoSetupRemote=true` を設定します。グローバル設定は変更しません。`ExecutionPolicy Bypass` はこのPowerShellプロセスだけに適用し、Windowsの実行ポリシーを変更しません。共用・junctionの `node_modules` を使う作業コピーでは依存関係を再インストールせず、専用のクローンで `npm ci` します。

## 日々の開発

未コミットの作業を保管し、次の手順で最新のmainから開始します。

```powershell
git switch main
git pull --ff-only origin main
git switch -c codex/describe-the-change
```

実装後は `npm run check` で単体テスト、型検査、ビルド、6種類のヘッドレス画面検証を実行します。画面検証にはEdge / Chrome / Chromiumが必要です。標準位置にない場合は `MAKUA_HEADLESS_BROWSER` に実行ファイルのパスを指定します。検証結果はGit対象外の `.local/` に保存されます。

```powershell
npm run check
git add <変更したファイル>
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

PRの統合済み状態と未保存の作業がないことを確認し、ローカルの作業ブランチを削除します。squash mergeはコミットIDが変わるため、この確認後に `git branch -D codex/describe-the-change` を使います。mainへの直接pushは通常の開発では使いません。

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

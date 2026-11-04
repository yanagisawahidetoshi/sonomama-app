# PBI → SBI Plannerの運用

1. PBIをGitHub Issueに書く。Issueの作成画面で「PBI」テンプレート（`.github/ISSUE_TEMPLATE/pbi.md`）を選ぶ。背景・目的・受け入れ要件・対象外を埋めると分割精度が上がる。
2. `gh auth status`で対象リポジトリへissues: writeできることを確認する。
3. `pnpm planner:sbi https://github.com/<owner>/<repo>/issues/<number>`を実行する。
   providerの既定はclaude。Codexだけ使える場合は`--provider codex`を付ける。CLIはインストール・ログイン済みでPATHから起動できることが必要。
4. SBI Quality JudgeがFAILならIssueは作成されず、exit 1で修正理由が表示される。PBIを直して再実行する。
5. PASSなら依存順にSBI Issueを作成し、`sbi`と`needs-review`を付与する。承認に使う`spec-approved`・`plan-approved`ラベルもリポジトリに作るが、どのIssueにも付けない。元PBIの本文に`## SBI構成`（SBI ID・Issue番号・kind・依存の完全な集合）を書き、`## Generated SBI`一覧をコメントする。
6. 人間がSBI Issueをレビューする。見るのは分割粒度、受け入れ要件、Gherkin、依存関係、Security影響、検証方法。
7. 採用するSBIは、ACごとのTrusted Acceptanceを人間が書いてレビューし、
   `.harness/acceptance/sbi-<SBI番号>.json`に`{ "version": 1, "sbiIssue": <SBI番号>, "verifiers": [{ "id", "trustedScript", "planned", "acceptanceIds": [IssueのAC ID] }] }`で登録する。
8. 全ACの対応を確認したら`needs-review`を外して`ready`を付ける。`gh issue edit <number> --remove-label needs-review --add-label ready`。
   `ready`は、write以上の権限を持つ人間（botは数えない）が付けたときだけ、付けた時点のIssueを承認する（#194・#200）。最後に`ready`を付けた人で判定する。付けた後に本文を編集するかtitleを変えると、元に戻してもrunは開始せず、CIも通らない。見直してから`ready`を外し、付け直す。判定はGitHubのtimeline（labeled・renamed）と本文の編集履歴の日時で行い、同じ秒の編集も後とみなす。
   新方式（#147、[ADR-0005](../../docs/adr/0005-generated-trusted-acceptance.md)・[ADR-0009](../../docs/adr/0009-label-human-approval.md)）: Trusted Acceptanceを手書きせず、GitHub上でIssueの`needs-review`を外して`spec-approved`ラベルを付ける。これが仕様の承認で、付けた人は確かめない（MVP）。`pnpm harness:spec-approve <SBI Issue URL>`も同じラベル操作をする。runは開始時点のIssueからspec digest（title・Planner marker・目的・種類・受け入れ要件・Gherkin・依存SBI・想定変更範囲・想定変更ファイル数・検証方法・Risk / Security Impact）を計算してテストを生成し、`.harness/acceptance/sbi-<番号>.json`（version 2）と一緒に実装PRに入れる。生成後にこれらを編集すると、CIで生成済みのTrusted Acceptanceが無効になる。今はRailsのrequest specだけを生成できる。
9. PBIの`## SBI構成`を確認し、GitHub上でPBIに`plan-approved`ラベルを付けて承認する（下記「PBI plan」）。
10. `pnpm harness:run <SBI Issue URL>`で実行する。SBI JSONは書かない。HarnessがIssueを取得・検証し、Run snapshotを保存して実装・検証・PR作成まで進める。

## SBIの種類

| kind | 開始条件 | 完了条件 |
| --- | --- | --- |
| implementation（実装SBI） | dependsOnのSBIが完了 | PRがmainへmerge済み、必須VerifierがPASS、E2E対象ならモックAPIのMaestro E2EがPASS |
| validation（最終確認SBI、Integration / E2Eが必要なPBIだけ1件まで） | 同じPBIの実装SBIがすべて完了 | 実API / Rails / DBへ接続したMaestro E2EがPASS |

人間による結合確認はSBIにしない。すべての実装SBIが完了し、最終確認SBIがあればPASSした後に、人間が確認環境でPBIの受け入れ条件に沿って操作する。
確認した環境・コードの版・結果をPBIのコメントに残し、問題がなければGitHubでPBI Issueを「完了」として閉じる。不具合があれば修正SBIを追加し、再確認する。
専用の受け入れコマンド・ローカル承認台帳・承認用digestの入力は不要。AIは人間の代わりに受け入れ確認やPBIのクローズを行わない。
PBIは、すべてのSBIが完了し、PBI Issueが`state: closed`かつ`state_reason: completed`で、blocker（GitHub issue dependenciesの`blocked by`）がすべてclosedのときだけ完了する。判定は`pbi-judge.mjs`の`judgePbi`で行う。
PBIの再オープン・「対応しない」としてのクローズ・状態の取得失敗はNOT_DONE。完了後に要件やSBI構成を変える場合はPBIを再オープンし、実装後に人間が再確認して閉じる。
人間による動作確認の実施やコメントの内容は機械判定しない。HarnessはGitHub上の完了状態を受け入れ確認の記録として扱う。SBIのCI・PRレビュー・マージ判定は引き続き必要。
Maestroのlane（実装SBIはモックAPI、最終確認SBIは実API）とCompletion Judgeでの必須判定は[ci.md](ci.md)にある。

### PBI plan（PBIのSBI集合）

PBIのSBI集合の正本は、Plannerが書いた`## SBI構成`と、PBIの`plan-approved`ラベル（ADR-0009。付けた人は確かめない）の組。
`pnpm harness:pbi-plan-approve <PBI URL>`は、`## SBI構成`がGitHub上のSBI Issue（`sbi`ラベルとPlannerのmarker）と一致するときだけ、PBIに`plan-approved`ラベルを付ける。撤回は`--decision revoke`でラベルを外す。

- digestは、PBI番号と、SBIごとのSBI ID・Issue番号・kind・依存（ID順に並べ、依存も並べる）のsha256。`harness:pbi-status`は、`## SBI構成`とGitHub上のSBI Issueが一致しなければラベルがあってもNOT_DONEにする。
- revisionは、GitHubが保持するPBI本文の編集履歴（GraphQL `userContentEdits`）と現在の本文を古い順に並べ、`## SBI構成`の内容が変わった回数＋1。人は書かない。節の外の編集では変わらない。履歴から削除された版は中身を読めないので「変わった」と数える。approval key = sha256(`<digest>:<revision>`)。A → B → Aと戻すとrevisionは3になる。approval keyは旧方式で作成したEvidence manifestの互換読み取りに使い、変わればそのmanifestは無効になる。
- `## SBI構成`が無い既存のPBIは、`pnpm harness:pbi-plan <PBI URL>`でGitHub上のSBI IssueからPBI本文に書いてから承認する。Plannerは再実行しない。

### PBIの完了判定

```sh
pnpm harness:pbi-status <PBI URL> [--json]
```

`harness:pbi-status`は次を集めて`judgePbi`に渡し、`DONE` / `NOT_DONE`と理由を表示する（DONEはexit 0、NOT_DONEはexit 2）。`--json`は同じ結果をJSONで出す。

| 入力 | 取得元 |
| --- | --- |
| PBI plan | PBI本文の`## SBI構成`とPBIの`plan-approved`ラベル。無い・未承認のときはNOT_DONE |
| SBI | `sbi`ラベルのIssueのうち、Plannerのmarkerがこのpbi URLを指すもの。kindは`## 種類`、依存は`## 依存SBI`。承認済みPBI planと完全に一致しなければNOT_DONE（「SBI #N が見つかりません」「SBI #N が承認済みPBI planに登録されていません」）。同じSBI IDのIssueが2件あってもNOT_DONE |
| merge | 依存SBIの確認と同じ。mainへmergeされ、`Closes #N`と`SBI-Issue:` trailerを持つHarness PR。Issueを手で閉じただけでは数えない |
| 必須Verifier | merged PRのhead SHAのcheck run。`github.requiredChecks`とmainのRulesetのrequired status checksがすべてsuccess |
| kind・E2E対象 | merged PRのhead SHAに入っている `.harness/state/sbi-<N>.json`（CIがIssueとの一致を確かめたsnapshot）。Issueの`## 種類`と一致しなければNOT_DONE。E2E対象かどうかはImpact Analysisと同じ`maestroLanes`で決める |
| E2E Evidence | merged head の `harness` checkが属するworkflow runの `maestro-results` artifact（`<lane>.json`）。実装SBIは`mock.json`、最終確認SBIは`real.json`だけを読む。lane・headSha・flow 1件以上・ログartifact 1件以上をCompletion Judgeと同じ条件で確かめる |
| blocker | PBIのGitHub issue dependencies（blocked by）。labelは見ない。closedでないものが1件でもあればNOT_DONE |
| Human Acceptance | GitHubのPBI Issueが`closed`かつ`state_reason: completed`であること。ローカル承認台帳は読まない |

GitHub・Evidenceを読めなければ、理由を出してNOT_DONEにする。
Evidenceを読むのはmainへmergeされたHarness PRのCI runだけなので、最終確認SBIもHarness PRをmergeする必要がある。

`harness:pbi-status`は任意の確認用コマンド。全SBIが完了していてPBIがopenなら、人間に動作確認結果の記録とPBIのクローズを案内する。GitHubへ書き込むことはない。
Evidence digestは検証対象の識別用に表示するが、人間が承認のために入力する必要はない。`harness:pbi-accept`は廃止した。
旧方式で保存済みの署名付きEvidence manifestは、artifactが期限切れになった場合の互換読み取りだけに使う。plan・SBI構成・PR・SHA・workflow run・artifactの一致と署名検証を維持する。旧受け入れ承認は完了の根拠にせず、PBIが再オープンされていればNOT_DONEにする。新しいmanifestは作成しない。

## SBI Issueの項目

種類、ID / タイトル、目的、対象範囲（必要なら対象外）、受け入れ要件、Gherkin、依存SBI、想定変更範囲、
レイヤー、想定変更ファイル数（目安超過なら理由）、Risk / Security Impact、検証方法、Gherkinと実テストの対応、元PBI。
詳細設計・関数名・実装手順・見積は含めない。

## SBIの粒度

SBI Quality Judgeは次を検査し、満たさなければIssueを作成しない。

| kind | レイヤー | 想定変更ファイル数 | 実テスト |
| --- | --- | --- | --- |
| implementation | 1つだけ。想定変更範囲が複数の`apps/*`にまたがればFAIL | 1以上。10を超えるなら分割できない理由が必須 | Application TestとScenarioごとのtestが必須。lint / typecheckだけや「不要」はFAIL |
| validation | 制約なし（PBI全体を通す） | 制約なし | E2EとScenarioごとのtestが必須 |

2時間の目安はPlannerの判断基準で、Judgeは機械判定しない。
実装後PRの変更ファイル数は、CIのCompletion Judgeが`judgeChangedFileCount`でIssueの想定と比べ、10と想定の両方を超えたらFAILにする（[ci.md](ci.md)）。

## 失敗時

- 不正なURL、取得失敗、Pull RequestのURL: exit 1。GitHubへは書き込まない。
- providerのescalation（PBIが曖昧など）: exit 1。確認事項を表示する。
- providerの出力に秘密値らしき文字列: exit 1。GitHubへは書き込まない。
- Issue作成の途中失敗: 作成済みのIssue一覧を表示してexit 1。元PBIへのコメントは投稿しない。
  再実行すると本文のmarker（PBI URL + SBI ID + 内容digest）で既存Issueを探し、open・`needs-review`付き・title/本文が今回の生成結果と
  完全一致するものだけを再利用して、未作成分だけを作る。
- 既存SBI Issueが再利用条件を満たさない（digest不一致、人間が本文やtitleを編集、`ready`化、closed）: 該当Issue番号と理由を表示してexit 1。
  GitHubへは書き込まない。人間が差分を確認し、古いIssueを閉じて`sbi`ラベルを外すか、内容を確定してから再実行する。既存Issueの本文は自動更新しない。

## GitHub Actionsで実行する場合

`GITHUB_STEP_SUMMARY`があれば同じ一覧をJob Summaryへ追記する。
workflowはこのリポジトリに含めていない。追加する場合は`issues: write`とprovider CLIの認証情報が必要で、
Secretの変更はLEVEL 3 / Security Gateの対象、CI/CDの変更はLEVEL 2・SEC-CICD-001の対象になる。

## やらないこと

Jira等の他トラッカー、`ready`への自動遷移、Human Reviewの省略、最終Risk確定、自動merge。

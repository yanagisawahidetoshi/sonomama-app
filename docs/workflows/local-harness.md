# 開発フロー

## SBIを用意する

1. PBIのGitHub Issueから、`pnpm harness:plan <Issue URL> --provider claude`でSBI Issueを作る。手順は[pbi-sbi-planner.md](pbi-sbi-planner.md)。
2. 人間がSBI Issueをレビューし、採用するものに`ready`を付ける。
3. SBI JSONを書く。Gherkin、AC、許可ファイル、riskを記載し、各ACを信頼するVerifierへ対応付ける。
   書き方は[sbi-template.md](../product/sbi-template.md)と`.harness/state/sample-sbi.json`。
4. `pnpm harness:check --sbi <SBI JSON>`で検証し、SBIと設定をcommitする。

## 実行と承認

```sh
pnpm harness:run --provider claude --sbi <SBI JSON>
```

失敗すると修正と再検証を繰り返す。連続3回失敗などで止まるとESCALATEDになる。
runが承認待ちで止まったら、人間が確認して承認し、`resume`で再開する。

| 状態 | 人間が確認すること | コマンド |
| --- | --- | --- |
| WAITING_FOR_HUMAN_GATE | 設計と作業範囲 | `pnpm harness:approve --run RUN_ID --phase gate` |
| WAITING_FOR_DESIGN_APPROVAL | 試作を本番へ採用する設計 | `pnpm harness:approve --run RUN_ID --phase design` |
| WAITING_FOR_HUMAN_REVIEW | risk-assessmentとHEADの差分 | `pnpm harness:approve --run RUN_ID --phase merge` |

```sh
pnpm harness:resume --run RUN_ID

# 承認の取り消し、修正要求
pnpm harness:approve --run RUN_ID --phase merge --decision revoke
pnpm harness:approve --run RUN_ID --phase merge --decision request-changes
```

実装後の承認は、LEVEL 2なら1人、LEVEL 3なら異なる2人以上が必要。
resumeで再評価してMERGE_ALLOWEDとautoMergeEligibleを確認する。
実際のmergeは人間か、将来の別adapterが行う。このHarnessはmergeしない。

## 承認の注意

- ゲート承認とマージ承認は別purpose・別contextなので、使い回せない。
- 証跡のapprovals.jsonを編集しても承認にならない。人間用CLIの署名付き台帳を使う。
- OSユーザーの別名は別人として数えない。複数人で承認する本運用には、認証済みの承認adapterを接続する。
- SHA・source・SBI・Rules・検証コードが変わったら、新しいrunで検証と承認をやり直す。
- 途中のiterationはresumeしない。resumeで再開・再評価できるのは承認待ちのrunだけ。
- 承認を撤回した後も、resumeでMERGE_ALLOWEDを取り消せる。

## 後片付け

```sh
pnpm harness:export --run RUN_ID   # 伏せ字化したレビュー用ZIP
pnpm harness:cleanup --run RUN_ID  # cleanなworktreeだけ削除。証跡は残る
```

GitHub PR、Ruleset、CODEOWNERS、実際のmergeは対象外。

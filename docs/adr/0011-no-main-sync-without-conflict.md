# ADR-0011: mainが進んだだけではPRの追従を求めない

- 状態: Accepted（2026-11-03、柳沢英俊が#288・#292のレビューで承認）
- 日付: 2026-11-03
- 判断者: 柳沢英俊
- 関連Issue: #288
- 関連SBI: なし
- 関連Design Docs: [.ai/workflows/pull-request.md](../../.ai/workflows/pull-request.md)、[docs/workflows/github-ruleset.md](../workflows/github-ruleset.md)
- Supersedes: [ADR-0001](0001-github-review-merge-approval.md)の「PRのbaseをrunのbaselineに固定する」部分、[ADR-0003](0003-reverify-after-main-update.md)の「mainが進むたびに再検証する」運用
- Superseded by:

## 背景

ADR-0001はPRのbaseをrunのbaselineに固定し、mainが進んだら`base_not_baseline`でBLOCKEDにした。ADR-0003はその解消に`harness:reverify`を使う。
mainのRulesetの「branchを最新にする」（strict）も有効だったため、他のPRがmergeされるたびに、追従・CI再実行・Approveの取り直しが発生していた。#288の目的は、この待ち時間を減らすこと。

## 決定

- mainが進んだだけでは、PRの作成もmerge判定も止めない。Rulesetのstrictは無効にする（適用済み）。
- 次の条件は維持する。どれかを満たさなければBLOCKED。
  - PRのbase branchが`github.base`（`base_branch_mismatch`）
  - GitHubがbaseとのconflictを報告していない（`merge_conflict`）
  - PR HEADがtested SHA（`tested_sha_mismatch`）
  - 必須CIがそのHEADに対して成功（`required_ci_not_passed`）
- PR作成時は、baseがrunのbaselineを含み、tested SHAとconflictしないことだけを確かめる。
- merge結果の検証は、merge後のmainへのpush（CIの`--all`、全テスト）が受け持つ。
- `harness:reverify`は通常フローから外し、最新のmainと統合して検証し直したいときだけ使う補助手段にする。

## 理由

| 案 | 却下理由 |
| --- | --- |
| baseline固定を残し、reverifyを自動化する | mainが進むたびにCIとApproveの取り直しが残り、待ち時間が減らない |
| conflictの有無だけを見る | PRの同一性（base branch・tested SHA・HEADへの必須CI）を失う |

## 影響

### Positive

- 他のPRがmergeされても、conflictがなければ追従・CI再実行・Approveの取り直しが要らない。

### Negative / Trade-offs

- mergeの結果（PR HEADと最新mainの統合）はmerge前に検証されない。意味的な衝突は、merge後のmainへのpushで見つかる。
- `harness:resume`は、元のcheckoutのHEADがbaselineのままであることを引き続き求める（`sourceIntegrity`）。本ADRでは変えない。

## 検証方法

`tools/harness/github-pr.test.mjs`で、mainが進んでもMERGE_ALLOWEDになること、conflict・base branch違い・tested SHA違いではBLOCKEDになること、mainが進んでもconflictがなければPRを作れることを確かめる。

## 再検討条件 / 撤回条件

merge後のmainへのpushで、PR単体では通ったのに統合で壊れる失敗が繰り返し起きたら見直す。

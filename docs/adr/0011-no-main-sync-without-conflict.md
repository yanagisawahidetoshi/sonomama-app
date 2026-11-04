# ADR-0011: mainが進んだだけではPRの追従を求めない

- 状態: Accepted（2026-11-03、柳沢英俊が#288・#292のレビューで承認）
- 日付: 2026-11-03
- 改訂: 2026-11-04、ADR-0003のうち今も有効な再検証runの決定をこのADRへ移し、実装の詳細を削った（このPRのmergeで承認）
- 判断者: 柳沢英俊
- 関連Issue: #288、#144、#148
- 関連SBI: なし
- 関連Design Docs: [.ai/workflows/pull-request.md](../../.ai/workflows/pull-request.md)、[docs/workflows/github-ruleset.md](../workflows/github-ruleset.md)
- Supersedes: [ADR-0001](0001-github-review-merge-approval.md)の「PRのbaseをrunのbaselineに固定する」部分、[ADR-0003](0003-reverify-after-main-update.md)の全体
- Superseded by:

## 背景

ADR-0001はPRのbaseをrunのbaselineに固定し、mainが進んだらBLOCKEDにした。ADR-0003はその解消に再検証runを使うと決めた。
mainのRulesetの「branchを最新にする」（strict）も有効だったため、他のPRがmergeされるたびに、追従・CI再実行・Approveの取り直しが発生していた。#288の目的は、この待ち時間を減らすこと。

## 決定

- mainが進んだだけでは、PRの作成もmerge判定も止めない。Rulesetのstrictは無効にする（適用済み）。
- 次の条件は維持する。どれかを満たさなければBLOCKED。
  - PRのbase branchが設定どおり
  - GitHubがbaseとのconflictを報告していない
  - PR HEADがHarnessの検証したSHA
  - 必須CIがそのHEADに対して成功
- PR作成時は、baseがrunのbaselineを含み、検証したSHAとconflictしないことだけを確かめる。
- merge結果の検証は、merge後のmainへのpush（全テスト）が受け持つ。

### 再検証run（補助手段）

最新のmainと統合して検証し直したいとき（conflictを解消したときなど）だけ、再検証run（`harness:reverify`）を使う。ADR-0003で決めた次の点は変えない。

- 実装Agentを呼ばず、最新のmainとPR HEADを統合したcommitを1回だけ検証する。失敗したら止め、PRは更新しない。
- 統合したcommitはPR HEADの子孫にし、PRブランチを通常のpushで更新する。rebase・force push・PRの作り直しはしない。旧runは書き換えない。
- 統合したcommitには実装runと再検証runへの関連付けを持たせ、必須checkで照合する。これは改ざんの検出で、認証ではない。承認の根拠はそのHEADへのGitHub Reviewで、旧HEADへのApproveは数えない。
- 入力・ルール・Riskは最新のmainのものを使う。差分は`baseline..統合したcommit`で判定し、SBIの範囲外の変更やSBIの変更があれば止めて新しいrunの実装に戻す。実装前の承認は取り直さない。
- forkのPRは再検証しない。

## 理由

| 案 | 却下理由 |
| --- | --- |
| baseline固定を残し、再検証を自動化する | mainが進むたびにCIとApproveの取り直しが残り、待ち時間が減らない |
| conflictの有無だけを見る | PRの同一性（base branch・検証したSHA・HEADへの必須CI）を失う |
| 再検証で、PRを新しいmainへrebaseする | force pushが必要になり、既存Reviewとcommitの対応が失われる |
| 再検証で、旧runのbaselineを差し替えてresumeする | 署名済みの旧runを書き換えることになり、改ざんにあたる |
| 再検証で、PRを閉じて作り直す | Review・議論の文脈が切れる |

## 影響

### Positive

- 他のPRがmergeされても、conflictがなければ追従・CI再実行・Approveの取り直しが要らない。

### Negative / Trade-offs

- mergeの結果（PR HEADと最新mainの統合）はmerge前に検証されない。意味的な衝突は、merge後のmainへのpushで見つかる。
- 再検証runの関連付けは誰でも書けるため、Harnessが書いたことの証明にはならない。

仕組みの詳細（判定の理由コード、統合したcommitの作り方、関連付けの形式）は実装とテスト、手順は[pull-request.md](../../.ai/workflows/pull-request.md)を正とする。

## 再検討条件 / 撤回条件

merge後のmainへのpushで、PR単体では通ったのに統合で壊れる失敗が繰り返し起きたら見直す。

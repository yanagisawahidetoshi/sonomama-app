# ADR-0001: 実装後Merge ApprovalのSource of TruthをGitHub Reviewにする

- 状態: Accepted（2026-10-27、柳沢英俊がPR #18の再レビュー後に承認）
- 日付: 2026-10-27
- 改訂: Accepted（PR #195 のマージで承認。2026-10-31、#175・#193の決定に合わせて実装前Gateの記述を改めた）
- 判断者: 柳沢英俊
- 関連SBI: Issue #15（GitHub PR Adapter）
- 改訂: 2026-11-04、ADR-0011に置き換えられた「PRのbaseをrunのbaselineに固定する」部分と、実装の詳細を本文から削った（このPRのmergeで承認）
- Superseded by: [ADR-0011](0011-no-main-sync-without-conflict.md)（mainが進んだときの扱いだけ）

## 背景

実装後のMerge Approvalは、ローカルの署名付き台帳（`harness:approve --phase merge`）に記録してきた。この台帳は、人をOSユーザーで識別する。
そのため、別のPCにいる開発者は承認を記録できない。また、Harnessが検証したcommitとGitHub上でレビューしているPRが、同じSHAであることを保証できない。

## 選択肢

| 案 | 却下理由 |
| --- | --- |
| ローカル台帳とGitHub Reviewの両方を必須にする | ローカル台帳は別PCの開発者と共有できない。操作が二重になる割に、本人性の保証はGitHub Reviewより強くならない。どちらが正本かも曖昧になる |
| ローカル台帳だけを使い続ける | チームでレビューする実態と合わない。PR HEADとの一致も確かめられない |

## 決定

- GitHub PR mode（HarnessがPRを作ったrun）では、実装後のMerge ApprovalのSource of TruthをGitHub Reviewにする。
  ローカル台帳への記録は要求せず、記録しようとしても拒否する。
- Local mode（PRを作っていないrun）では、従来のローカル台帳を使う。2つの方式を同時には要求しない。
- API Schema Approvalは、ローカル台帳のまま変えない。Design Approvalは#155で、実装前Gateは#175・#193で廃止した。
- 承認として数えるのは、APPROVEDの対象SHA、現在のPR HEAD SHA、Harnessが検証したSHAの3つが一致するReviewだけ。
  botとPR作成者は数えない。同じuserは1人と数え、最新のReviewだけを使う。CHANGES_REQUESTEDは対象SHAにかかわらずブロックする。
- Reviewは、GitHubと同じくリポジトリのwrite以上の権限を持つ人のものだけを数える。read以下の人のCHANGES_REQUESTEDもブロックにしない。
  権限を読めなかった人は、APPROVEDを数えず、CHANGES_REQUESTEDはブロックとして扱う。
- PRのbaseとmainの関係（mainが進んだときの扱い）は[ADR-0011](0011-no-main-sync-without-conflict.md)に従う。
- 必須CIは、Harnessの設定とRulesetのrequired status checksの和集合。Rulesetのcheckに`integration_id`があれば、そのGitHub Appのcheck runだけを数える。
- 必要な人数は、既存のRisk Policyに従う（LEVEL 1は0人、LEVEL 2は1人、LEVEL 3は異なる2人以上）。
- Harnessが出すのは`MERGE_ALLOWED`まで。`MERGED`はGitHubの状態を正本とし、Harnessでは生成しない。

## 影響と検証

- GitHub上のReviewやCIは随時変わるので、判定のたびにGitHubから取り直す。
- 実装Agentが人間と同じ`gh`の認証で動くと、人間名義のReviewを出せてしまう。これはHarnessでは検出できない。Agentの実行環境に、GitHubの認証情報を渡さない運用で防ぐ。
- 撤回する場合は、PR modeのrunでもローカル台帳を参照するように戻す。GitHub Reviewは`MERGE_ALLOWED`の判定以外には使っていないため、戻しても既存のデータは移行しなくてよい。

ADRへの変更はHuman Gate対象。AIだけで確定しない。

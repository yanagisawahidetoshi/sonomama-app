# ADR-0005: Trusted Acceptanceを、人が承認した仕様からrunの中で生成・検査・登録し、実装PRに同梱する

- 状態: Accepted（2026-10-30、柳沢英俊が承認）
- 日付: 2026-10-30
- 改訂: Accepted（PR #200 のマージで承認。2026-10-31、#194の決定に合わせてspec digestの対象とlegacy `ready`の扱いを改めた）
- 改訂: 2026-11-04、ADR-0009と矛盾する記述、L3 floorと生成の未実装を前提にした時限の記述、実装の詳細を削った（PR #315のmergeで承認）
- 判断者: 柳沢英俊（判断点は Issue #147 で決定）
- 関連Issue: #147、#168、#194
- 関連SBI: なし
- 関連Design Docs: [.ai/workflows/pbi-sbi-planner.md](../../.ai/workflows/pbi-sbi-planner.md)、[.ai/workflows/implementation.md](../../.ai/workflows/implementation.md)
- Supersedes:
- Superseded by: [ADR-0009](0009-label-human-approval.md)（仕様の承認の正本と `spec-approved` label の扱いだけ）

状態の意味とAIの扱いは[README](README.md)を参照する。

## 背景

以前は、人が SBI Issue の受け入れ要件と Gherkin をレビューした後、AC ごとの Trusted Acceptance（合否を判定するテスト）を人が書いて登録し、`ready` を付けてから実装が始まった。
人がテストを手書きすることが開発を始める前提になっていて、速度を落としていた。一方で、実装 Agent が自分でテストを書いて合格を名乗る形にはしたくない。

## 判断ドライバー

- 人は仕様（受け入れ要件・Gherkin）の確定だけを行い、テストを手書きしない
- AI の自己申告や常に成功するテストで AC を満たしたことにしない
- テストの生成と実装を分け、実装 Agent が保護されたテストを変えられないこと
- 開発の速度（登録のための別 PR や一律の追加承認を作らない）

## 選択肢

| 案 | 却下理由 |
| --- | --- |
| 生成したテストを別の「登録 PR」で先に main へ入れる | すべての SBI で登録のための PR と承認が増える。速度の目的に反する |
| 生成 Agent に `.harness/verification` への書き込み権限を与える | 候補の生成と、信頼する登録を分けられない |
| 仕様の承認を `ready` label のまま使う | 「登録済み」と「仕様確定」を区別できず、順序が循環する |

## 決定

- **仕様の承認と、テストの準備を分ける。**
  - 仕様の承認の正本は [ADR-0009](0009-label-human-approval.md) に従う（SBI Issue の `spec-approved` label）。
  - spec digest は、run の開始時点で計算し、生成したテストを結びつける。Agent への指示・Risk・Security 分類・実行範囲に使う承認対象の情報全体を正規化したテキストの sha256。今は title・Planner marker・目的・種類・受け入れ要件・Gherkin・依存SBI・想定変更範囲・想定変更ファイル数・検証方法・Risk / Security Impact を含む。生成後にどれかが変われば、生成した Trusted Acceptance は無効になる。チェックボックスの状態は含めない。runが新しい項目を読むようになったら、その項目も digest に入れる。
  - `ready` は生成方式の仕様承認には使わない。version 1 の手書き Trusted Acceptance を登録した SBI の legacy 互換経路としてだけ残す。
  - legacy `ready` では「label が付いていること」だけを信用しない（#194）。write 以上の権限を持つ人間（bot は数えない）が最後に `ready` を付けた時点の Issue 内容に束縛し、権限や付けた人を読めなければ無効にする。`ready` の後に本文か title が変わった場合は、元に戻しても無効にする。
- **生成と検査は二段階（G / I）にする。** 生成時点で「完成した実装に対して PASS」を求めない。G（生成時）で、制御した違反を検出できることを確かめ、I（実装後）で完成した実装を検証する。
- **生成したテストは実装 PR に同梱する。** 専用の acceptance test のディレクトリに置き、実装 Agent からは書き換えられないように保護する。
- **合否は main 側の信頼できる CI で判定する。** ローカルの証跡だけでは合格にしない（判定の仕組みは [ADR-0008（Completion Judge）](0008-trusted-completion-judge.md)）。
- **CI での実行場所:** PR のコードを実行する部分は、secret なし・network を遮断したコンテナで動かす。判定する側は生成物を実行せず、厳格な結果 schema だけを読む。

## 理由

人の役割を「仕様を決めて承認する」ことに絞れば、テストの手書きを待たずに開発を始められる。生成したテストを digest に結びつけるので、仕様が変われば古いテストは使われない。
G / I の二段階にすれば、まだ実装が無い時点でもテストの検出能力を確かめられる。

## 影響

### Positive

- 人がテストを手書きしなくても、承認した仕様から実装を始められる。
- 仕様の変更が、生成したテストを自動で無効にする。

### Negative / Trade-offs

- 生成したテストの妥当性の最終確認は、PR Review に残る。品質検査はヒューリスティックで、完全な保証ではない。
- adapter の無い種類の SBI は、生成できずに止まる。

仕組みの詳細（registration の形式、生成と品質検査、legacy `ready` の監査履歴の読み方）は実装とテストを正とする。

## 再検討条件 / 撤回条件

- 生成したテストの品質が実運用で足りず、人のレビューの負担がかえって増えたとき

## 関連資料

- Issue #147（設計案と判断点）、#168、#194（legacy `ready` の束縛とspec digestの対象）

ADRへの変更はHuman Gate対象。AIだけで確定しない。

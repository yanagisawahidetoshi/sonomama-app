# ADR-0006: Production変更の起点を、決定的なルールによるchange-type判定で決め、Engineering Issueを必須にしない

- 状態: Accepted（2026-10-30、柳沢英俊が承認）
- 日付: 2026-10-30
- 判断者: 柳沢英俊
- 改訂: 2026-11-04、実装済みのfollow-up、ルールの詳細、実装と検証方法の列挙を削った（PR #315のmergeで承認）
- 関連Issue: なし
- 関連SBI: なし
- 関連Design Docs: [docs/workflows/engineering-changes.md](../workflows/engineering-changes.md)、[.ai/workflows/ci.md](../../.ai/workflows/ci.md)
- Supersedes:
- Superseded by:

状態の意味とAIの扱いは[README](README.md)を参照する。

## 背景

以前は、Production（`lanes.json`の`productionPaths`、つまり`apps/`と`packages/`）を1ファイルでも変えるPRに、次のどれかの起点を必須にしていた。

- 承認済みSBI IssueからのHarness Runとsnapshot
- `engineering`と`ready`のlabelが付いたEngineering Issueと、commitの`Engineering-Issue:` trailer
- trusted dependency bot（Renovate）の例外

この結果、`apps/admin/README.md`の1行を直すPRでも、Issueを作り、人がlabelを付けるまでCompletion Judgeが通らない（#185）。
Engineering Issueのlabelは人がPRのレビューと別に付ける承認で、中身もレビューと重なる。Harnessはlabelの有無を見るだけで、Issueの内容とdiffを照合しない。labelはPRのHEADや変更内容に結びついていないので、Issueを承認した後にPRへ本番コードを足しても通る。
一方、L1の変更はSBIの承認後、できるだけ人の手を介さずに進める方針にしている（#182）。Engineering Issueを毎回求める運用はこれと合わない。

## 判断ドライバー

- 正解の定義（SBI → spec digest → spec approval → Trusted Acceptance）を持つべきProduct変更は、必ずSBIを通す
- AIの自己申告でGateを外さない（AGENTS.md）
- 人のタッチポイントを、判断が要る場面だけにする
- 判定できないものは、緩い側ではなく厳しい側へ倒す（fail-closed）

## 選択肢

| 案 | 却下理由 |
| --- | --- |
| 現状維持（Production変更にSBIかEngineering Issueを必須） | PRのレビューと承認が二重になる。Issueの承認はdiffやHEADに結びつかず、偽装の防止にもならない |
| 人がPRに`engineering` labelを付けたらEngineeringとする | L1の技術変更でも毎回人の操作が要る。#182の方針と合わない |
| LLMがdiffを読んでProduct / Engineeringを判定する | AIの自己申告でGateを外すことになる |
| ambiguousのたびに人へ質問する | 人のタッチポイントが増える。答えがない間の扱いも決める必要がある |
| ambiguousを、今のEngineering Issueで例外的にSBI無しにする | Issueの承認はdiffやHEADに結びつかない。承認後に足した本番コードも通ってしまう |
| `apps/`・`packages/`のMarkdownだけをProductionから外す | 依存更新・Storybook・テスト基盤などの技術変更が残り、Engineering Issueの問題は解消しない |

## 決定

### 判定のしくみ

- Production変更を含むPRのdiffに、Harnessが`changeType`と`requiresSbi`を付ける。diffの分類は次の2つだけとする。

| changeType | 条件 | requiresSbi |
| --- | --- | --- |
| `engineering` | Production配下の変更ファイルが、すべてEngineeringのルールに当たる | false |
| `ambiguous` | 1ファイルでもEngineeringのルールに当たらない | true |

- `ambiguous`は「Productと判定した」ではなく「Engineeringと証明できなかった」を表す。別の値に変換せず、`changeType = ambiguous`のまま保持する。
- `ambiguous`で人には質問しない。SBIが無ければCompletion JudgeはFAILする。
- 判定に使うのは、パス、ファイルの種類、diffの内容に対する決定的なルールだけとする。LLMの判定、PR本文、commit message、ブランチ名、「refactor」などの自己申告は使わない。
- ログには、どのファイルがどのルールに当たったか、どのファイルで`ambiguous`になったかも書く。
- ルールは`.harness/rules/`に置く。Agentは書き込めず、変更は既存のHuman Gateの対象になる。

### SBI sourceは別の軸で扱う

change-type（diffが何を変えているか）と、SBI source（変更がどのSBIから来たか）は混ぜない。

- PRがSBIのsnapshotを追加・変更・削除している場合は、change-typeにかかわらずSBI sourceを検査する。検査に失敗すればFAILする。
- `Harness-Run:`・`SBI-Issue:`のtrailerがあるだけでは、有効なSBI sourceとみなさない。trailerはchange-typeの判定にも使わない。snapshotの無いPRに残ったtrailerで、Engineeringのdiffが`ambiguous`になることも、`ambiguous`のdiffが通ることもない。
- `requiresSbi = true`のPRは、SBI sourceの検査に通ったsnapshotがあるときだけ通る。

### Engineeringと判定する変更

明確にEngineeringと証明できるものだけにする。ビルドと実行に入らないMarkdown、既存の依存のバージョンだけの更新とlockfile、Storybook、テスト、ビルド出力に効かない開発ツールの設定が該当する。
依存の追加・削除、本番の実行時に入るコードと設定は、「refactor」と称していても`ambiguous`にする。削除・renameで変更前のパスがルールに当たらないもの、symlink、バイナリも`ambiguous`にする。
「refactorだからEngineering」「AIがEngineeringと判断した」という理由ではGateを外さない。ルールの正本は`.harness/rules/change-types.json`。

### Engineering Issueの位置づけ

- Engineering Issueは起点の判定に使わない。`engineering`の変更には要らず、`ambiguous`の変更はEngineering Issueがあっても`requiresSbi = true`のままにする。
- Engineering Issueは、複数のPRにまたがる作業や、後から追いたい基盤作業を管理するときに任意で使う。
- 人に毎回`engineering` labelを付けさせる工程は作らない。
- 初期の実装では、`ambiguous`をSBI無しで通す例外を設けない。純粋なrefactorなどでSBI必須が実運用上の問題になったら、そのPRのHEAD SHAか変更内容のdigestに結びついた人の判断として、別のADRで設計する。

### テストの変更とRisk

- テストの変更は`engineering`になるが、これはSBIが要らないという意味だけを持つ。L1のAuto Mergeを安全にできるという意味は持たない。
- テストの削除、skip・pending・focus化、assertionを含む行の削除は、Risk側でLEVEL 2へ上げてL1のAuto Mergeから外す（[ADR-0008](0008-default-risk-level-one.md)）。
- 書き換えたassertionが弱くなったかどうか（`toBe(1)`を`toBeDefined()`にする等）までは判定しない。

### 変えないこと

- change-typeが決めるのは`requiresSbi`だけ。Verifier、Security Verifier、Risk Level、Human Gate、PRのHuman Reviewの判定は変えない。
- SBIのsnapshotを持つPRへのSBI sourceの検査の内容。
- trusted dependency botの例外は残す。

## 理由

- SBIが守っているのは「正解の定義」で、Product変更にしか意味がない。技術変更にSBIやIssueを求めても、守るものが増えない。
- 偽装を防ぐのはIssueの有無ではなく、diffがProductの領域に触れていないかの判定である。この判定をルールで機械的に、PRのdiffそのものに対して行う。
- ルールで言い切れないものは`requiresSbi = true`になるので、判定の漏れはSBIを余計に求める方向にしか出ない。

## 影響

### Positive

- README・依存更新・Storybook・テストだけのPRが、Issueもlabelも無しでCompletion Judgeを通る。
- 判定の根拠がログに出るので、なぜSBIが要るのかをPRの作者がその場で分かる。
- diffやHEADに結びつかないEngineering Issueの承認で、本番コードの変更がSBIを避ける経路がなくなる。

### Negative / Trade-offs

- 本番コードのrefactorは、挙動が変わらなくてもSBIが要る。例外の手段は初期の実装では用意しない。
- 依存のバージョン更新は、実行時の挙動を変えうるのに`engineering`になる。守りはVerifierとPRのレビューに頼る。
- テストの削除・弱体化も`engineering`になる。ACの判定はTrusted Acceptanceが別に持つので影響しない。
- `apps/**`のREADMEには、AIが実装時に守る制約が書かれている。これを変えるPRも`engineering`になり、確認はPRのレビューに頼る。
- ルールの保守が要る。新しい種類のファイルは、ルールに足すまで`ambiguous`になる。

## 実装・運用への影響

- Engineering Issueによる起点の検査は廃止した。
- Security rule（SEC-*）の対象範囲は変えない。

## 再検討条件 / 撤回条件

- `engineering`と判定されたPRで、本番の挙動が変わる事故が起きたとき
- 純粋なrefactorなどで`ambiguous`のSBI必須が実運用上の問題になったとき（HEAD SHAか変更内容のdigestに結びついた人の判断を、別のADRで設計する）

## 関連資料

- #182（L1のAuto Mergeを許可する方針）。Auto Mergeの実装（#157、#175）とは独立に進める
- #185（`apps/**`のREADMEの変更で、Completion Judgeが起点不足でFAILした例）
- [ADR-0005](0005-generated-trusted-acceptance.md)（SBIからTrusted Acceptanceを作る流れ）

ADRへの変更はHuman Gate対象。AIだけで確定しない。

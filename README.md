# SONOMAMA Local Harness

SBI単位で「実装、検証、修正」を繰り返し、Security・Risk・人間の承認をもとにマージしてよいかを判定するローカル基盤。
アプリ本体（Rails API / Expo / React admin）はまだplaceholder。Harnessは判定までを行い、実際のmergeは人間が行う。

## セットアップ

Node.js 22、pnpm 8、Git 2.28以上と、zip・unzipが必要。

```sh
pnpm install --frozen-lockfile   # pre-push hookも設定される
pnpm harness:check
pnpm harness:test
pnpm harness:demo                # 認証・外部通信なしのfake providerで一連の流れを実行
```

## 使い方

```sh
# SBIを実行する。providerはfake / codex / claude
pnpm harness:run --provider claude --sbi .harness/state/sample-sbi.json

# 承認待ちのrunを人間が承認し、再開する
pnpm harness:approve --run RUN_ID --phase gate    # 実装前の着手承認
pnpm harness:approve --run RUN_ID --phase design  # 試作を本番へ採用するときの設計承認
pnpm harness:approve --run RUN_ID --phase merge   # 実装後の差分承認
pnpm harness:resume --run RUN_ID

# 承認の取り消しと修正要求
pnpm harness:approve --run RUN_ID --phase merge --decision revoke
pnpm harness:approve --run RUN_ID --phase merge --decision request-changes

# GitHub IssueのPBIをSBI Issueへ分割する（認証済みのgh CLIが必要）
pnpm harness:plan https://github.com/<owner>/<repo>/issues/<number> --provider claude

# 伏せ字化したレビュー用ZIPを作る / runのworktreeを片付ける
pnpm harness:export --run RUN_ID
pnpm harness:cleanup --run RUN_ID
```

run・resumeの終了コードは、MERGE_ALLOWEDなら0、承認待ちや停止なら2、入力やCLI操作のエラーなら1。

## 人間が判断すること

- 実装が終わってExecution DONEになっても、マージを承認したことにはならない。
- 実装後に必要な承認人数はRiskで決まる。LEVEL 1は0人、LEVEL 2は1人、LEVEL 3は異なる2人以上。既定はLEVEL 2。
- 実装前の着手承認（gate）は、実装後の承認人数に数えない。
- 承認はSHAと入力に紐付く。commitや設定を変えたら、新しいrunで検証と承認をやり直す。
- AuthN/AuthZ/RLS/PII/Migration/ADRに関わる変更は実装前に止まる。判断はSBIやADRに残す。

## ドキュメント

- [docs/workflows/local-harness.md](docs/workflows/local-harness.md): 承認からMERGE_ALLOWEDまでの運用手順
- [docs/workflows/pbi-sbi-planner.md](docs/workflows/pbi-sbi-planner.md): PBIをSBIへ分割する手順
- [docs/workflows/quality-gates.md](docs/workflows/quality-gates.md): ローカル開発とPRの品質ゲート
- [docs/security/README.md](docs/security/README.md): Security Requirements
- [docs/architecture/harness-reference.md](docs/architecture/harness-reference.md): Verifier、Risk判定、Evidence、Lane、秘密情報保護などの詳細仕様
- [AGENTS.md](AGENTS.md): 開発ルール

# SONOMAMA Local Harness

SONOMAMAのアプリと、AIに実装させて検証・判定するローカル基盤（Harness）のリポジトリ。
HarnessはSBI（作業単位）ごとに「実装 → 検証 → 修正」を回し、Security・Riskの判定とmergeしてよいかの判定までを行う。実際のmergeは人が行う。

## 現在の状況

| 対象 | 状況 | 詳細 |
| --- | --- | --- |
| apps/api | Rails API。Docker Compose・RSpec・RuboCop・Brakeman等を接続済み。業務APIは未実装 | [apps/api/README.md](apps/api/README.md) |
| apps/mobile | Expo（受講生アプリ）。Jest・Biome・expo-doctorを接続済み。業務画面は未実装 | [apps/mobile/README.md](apps/mobile/README.md) |
| apps/admin | React + Vite（管理画面）。Vitest・Biome・buildを接続済み。業務画面は未実装 | [apps/admin/README.md](apps/admin/README.md) |
| prototypes/web・mobile | デザイナー用の試作。軽量の検証だけ行う | [docs/architecture/README.md](docs/architecture/README.md) |
| packages/api-schema | API仕様（OpenAPI 3.1）の置き場所 | [packages/api-schema/README.md](packages/api-schema/README.md) |
| 認証 | Amazon Cognito（User Pool）を使うと決定済み（ADR-0007）。実装はまだ無い | [apps/api/README.md](apps/api/README.md#認証) |
| CI・Ruleset | mainへのmergeには`Completion Judge`チェックの成功が必要 | [docs/workflows/github-ruleset.md](docs/workflows/github-ruleset.md) |

## 準備

Node.js 22以上、pnpm 8以上、Git 2.28以上、Docker（Verifierの実行に使う）が必要。

```sh
pnpm install --frozen-lockfile
pnpm harness:check   # 設定とルールの整合性を確認する
pnpm harness:test    # Harnessのテスト
pnpm harness:demo    # 認証・外部通信なしでHarnessの流れを一通り動かす
```

## 開発の流れ

```sh
pnpm planner:sbi https://github.com/<owner>/<repo>/issues/<PBI番号>   # PBIからSBI Issueを作る
# 人がSBI Issueをレビューし、needs-review を spec-approved に替える
pnpm harness:run https://github.com/<owner>/<repo>/issues/<SBI番号>   # 実装・検証してPRを作る
```

PRは人がGitHubでレビューしてmergeする。mainが進んでも追従は要らず、conflictが出たときだけ解消する（[ADR-0011](docs/adr/0011-no-main-sync-without-conflict.md)）。
流れの全体は[docs/workflows/README.md](docs/workflows/README.md)にある。

## どこを読むか

| 知りたいこと | 文書 |
| --- | --- |
| 設計・セキュリティ要件・ADR | [docs/README.md](docs/README.md) |
| 開発の流れと手順書 | [docs/workflows/README.md](docs/workflows/README.md) |
| AIへの開発指示 | [AGENTS.md](AGENTS.md)、[.ai/](.ai/) |
| Harnessの仕様の詳細（Verifier・Risk・Evidence等） | [.ai/harness-reference.md](.ai/harness-reference.md) |

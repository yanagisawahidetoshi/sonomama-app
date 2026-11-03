# SONOMAMA

Rails API / Expo / React adminで構成するSONOMAMAのモノレポ。
AIによる実装と検証を支援するLocal Harnessも含む。Harnessは開発を支援する裏方で、mergeしてよいかの判定までを行う。

| 対象 | 状況 |
| --- | --- |
| [apps/api](apps/api/README.md) | Rails API mode。業務APIは未実装 |
| [apps/mobile](apps/mobile/README.md) | Expo（受講生アプリ）。業務画面は未実装 |
| [apps/admin](apps/admin/README.md) | React + Vite（管理画面）。業務画面は未実装 |
| [packages/api-schema](packages/api-schema/README.md) | API契約（OpenAPI 3.1） |
| 認証 | Amazon Cognito（[ADR-0007](docs/adr/0007-aws-and-cognito.md)） |

## Setup

Node.js 22、pnpm 8.15.2以上9未満、Git 2.28以上、Dockerが必要。

```sh
pnpm install --frozen-lockfile   # pre-push hookも設定される
pnpm harness:check
```

## Development

```sh
# PBIのGitHub IssueからSBI Issueを作る
pnpm planner:sbi https://github.com/<owner>/<repo>/issues/<PBI番号>

# 人がSBI Issueをレビューし、needs-review を spec-approved に替える

# SBIを実装し、検証に通ったらPRを作る
pnpm harness:run https://github.com/<owner>/<repo>/issues/<SBI番号>
```

mainが進んでもPRを追従させる必要はない。conflictが出たときだけ解消する。

## Docs

- [開発の流れ](docs/workflows/README.md)
- [設計資料の一覧](docs/README.md)
- [AI向けの開発ルール](AGENTS.md)

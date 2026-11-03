# SONOMAMA

Rails API / Expo / React adminで構成するSONOMAMAのモノレポ。

AIによる実装と検証を支援するLocal Harnessも含む。Harnessは開発を支援する裏方で、マージは人間が判断する。

## Setup

Node.js 22 / pnpm 8 / Git 2.28以上が必要。

```sh
pnpm install --frozen-lockfile
pnpm harness:check
```

## Development

```sh
# PBIのGitHub IssueからSBIを作る
pnpm harness:plan <GitHub Issue URL> --provider claude

# レビュー済みのSBIをJSONに書き、実装する
pnpm harness:run --provider claude --sbi <SBI JSON>
```

runが承認待ちで止まった後の手順は[開発フロー](docs/workflows/local-harness.md)にある。

## Docs

- [開発フロー](docs/workflows/local-harness.md)
- [品質ゲート](docs/workflows/quality-gates.md)
- [Security](docs/security/README.md)
- [Harness詳細](docs/architecture/harness-reference.md)
- [AI開発ルール](AGENTS.md)

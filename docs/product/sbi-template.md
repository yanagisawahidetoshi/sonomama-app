# SBIテンプレート

SBIは、PBIをAIが実装できる大きさに分けた作業単位である。通常はPlannerが作ったSBI Issueを人がレビューし、`needs-review`を`spec-approved`に替えて、`pnpm harness:run <SBI Issue URL>`で実行する。`spec-approved`ではTrusted Acceptanceをrunの中で生成する。人が書いたTrusted Acceptanceを`.harness/acceptance/sbi-<番号>.json`に登録した場合は`ready`を付ける。HarnessがIssueから下のJSONを組み立てるので、人はJSONを書かない。下のJSON形式はHarness自己テスト（`--sbi`）用。

## 書く項目

| 項目 | 書く内容 |
| --- | --- |
| ID / タイトル | SBIを区別するIDと、実現する振る舞いを1行で |
| 種類（kind） | implementation（実装）/ validation（最終確認、必要なPBIだけ）。省略時はimplementation。人間確認はSBIにせずPBI Human Acceptance Gateで扱う |
| 目的 / ユーザー価値 | 何のためのSBIか |
| 対象範囲 / 対象外 | 変更する画面・API・機能と、扱わないもの |
| 受け入れ要件（acceptance criteria） | 何ができれば受け入れるか。項目ごとに一意のIDを付ける。各IDは、Trusted Acceptanceのちょうど1件と対応させる |
| 変更してよいファイル（allowedFiles） | AIが変更してよいファイルの相対パス。書いたファイルだけを許可する |
| 変更してよいディレクトリ（allowedDirs） | 末尾`/`付きのディレクトリ。配下のファイルを許可する。SBI Issueの想定変更範囲から作る |
| リスク（risks） | Human Gateの対象となる影響だけを書く。認証（AuthN）、認可（AuthZ）、行単位のアクセス制御（RLS）、個人情報（PII）。マイグレーションやADRはここではなくsecurityImpactとriskCandidateで表す |
| あいまいさ（ambiguous / requiresDesignDecision） | 仕様があいまいか、先に設計の判断が要るか。真偽値で書く |

受け入れ要件は、次の形のシナリオで書く。

```gherkin
Feature: [機能]
  Scenario: [観測できる振る舞い]
    Given [前提]
    When [操作]
    Then [期待する結果]
```

## セキュリティに関わる項目

| 項目 | 書く内容 |
| --- | --- |
| securityImpact | 影響するセキュリティの分類（RLS、PII、AuthN、AuthZなど）。分類は.harness/rules/security.jsonで定義している |
| requiredSecurityRules | 関係するルールID（SEC-RLS-001など） |
| requiredVerifiers | このSBIのために追加で必須にする検証 |
| preImplementationGate | trueなら、SBI承認で人が判断した安全性に関わるSBIとして扱う。実装前には止めず、レベル3と実装後の2人以上のレビューを求める |
| minimumRiskLevel | 1・2・3のどれか（既定は1） |

SBI IssueからHarnessが組み立てる場合、preImplementationGateは常にfalse、requiredVerifiersは空になる。minimumRiskLevelは、PlannerのRisk候補がL3かsecurityImpactがあれば3、L2なら2、それ以外は1になる。

ここに書いた値で、docs/securityのルールを弱めることはできない。ルールが求める検証を省いても、Harnessは必ず実行する。必須の検証が用意されていなければ、そこで止まる。

JSONの例は.harness/state/sample-sbi.jsonにある。

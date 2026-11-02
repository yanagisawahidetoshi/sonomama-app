# no-api-contract

CI-AC-14（`ci-matrix.mjs`）が使う workspace です。`packages/api-schema` に OpenAPI 文書を置かないことで、「required verifier の app が存在しない」状態を再現します。

リポジトリ本体の契約（`packages/api-schema/openapi.yaml`）に左右されずに検証するためのものです。このディレクトリに OpenAPI 文書を追加しないでください。

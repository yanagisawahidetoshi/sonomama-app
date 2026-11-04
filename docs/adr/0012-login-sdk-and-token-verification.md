# ADR-0012: ログインにAmplify Authを使い、APIはAccess Tokenを汎用のJWTライブラリで検証する

- 状態: Proposed
- 日付: 2026-11-04
- 判断者: 未定
- 関連Issue:
- 関連SBI: なし
- 関連Design Docs: [docs/architecture/authentication.md](../architecture/authentication.md)
- Supersedes: なし
- Superseded by:

状態の意味とAIの扱いは[README](README.md)を参照する。Proposedの間は、AIはこのADRを決まったものとして実装や提案の根拠にしない。

## 背景

認証基盤はCognitoに決まった（[ADR-0007](0007-aws-and-cognito.md)）。ただし、各アプリのREADMEは、Provider固有のSDK・gemを承認なしに導入しないとしている。
ログインを実装するには、受講生アプリ・管理画面でCognitoとやり取りする方法と、APIでトークンを検証する方法を決める必要がある。

## 判断ドライバー

- 受講生アプリのログイン画面を、SONOMAMAのデザインで作れること
- 管理画面のログイン画面の実装と保守を少なくすること
- パスワードをSONOMAMAのアプリやAPIが扱わないこと
- Cognito固有の実装を、各アプリとAPIの決まった場所に閉じること

## 選択肢

| 案 | 却下理由 |
| --- | --- |
| Cognitoのログイン画面（Managed Login）へリダイレクトする | 受講生アプリの画面を独自のデザインにできない。管理画面だけ採ると、2つのアプリでログインの流れが分かれる |
| AWS SDKでCognitoのAPIを直接呼ぶ | SRPの計算とトークンの更新を自前で実装することになる |
| ログインをAPI経由にする（パスワードをAPIへ送る） | APIがパスワードを扱うことになり、判断ドライバーの「パスワードをSONOMAMAのアプリやAPIが扱わないこと」に反する |
| APIでID Tokenを検証する | Cognitoのドキュメントは、APIの操作を認可するのはAccess Tokenの役割としている |
| APIでCognito専用のgemを使う | apps/apiのREADMEは、Provider固有のgemを承認なしに導入しないとしている。検証項目は汎用のJWTライブラリで足りる |

## 決定

未決定。現時点の提案は次のとおり。

- 受講生アプリと管理画面は、Amplify Auth（v6）でCognitoとやり取りする。Amplifyを使うのは各アプリの認証の部分だけにし、ほかの機能からは使わない。
- 受講生アプリのログイン画面は独自に作る。Amplify AuthがExpo Goで動かないため、Development Buildを使う。
- 管理画面のログイン画面は、Amplify UIの`Authenticator`を使う。
- User Poolは環境ごとに分け、App Clientは受講生アプリ用と管理画面用に分ける。どちらもClient Secretを持たない。パスワードをそのまま送るログインの方式は許可しない。
- APIは、Bearerで受け取ったAccess Tokenを、汎用のJWTライブラリとUser Poolの公開鍵（JWKS）で検証する。
- APIのユーザーとCognitoのユーザーは、トークンの`sub`で結ぶ。メールアドレスでは結ばない。

検証する項目、Amplifyを置く場所、DBの列名は設計文書で決める。

## このADRで決めないこと

- ユーザー登録と初回のパスワード設定（[ADR-0002](0002-user-registration-and-invitation.md)）
- ログインIDの形式（ADR-0002）
- MFA、アカウント停止時の扱い、権限表
- Access Tokenの有効期間（設計文書の未決事項）

## 理由

2つのアプリで同じSDKを使うと、トークンの取得・更新・ログアウトの扱いが揃う。受講生アプリは画面だけを独自に作り、管理画面は画面もSDKに任せることで、デザインの自由と実装の少なさを両立できる。
APIの検証を汎用のライブラリで書けば、Cognitoに依存するのは検証の設定（Issuer・JWKSのURL・Client ID）だけになる。

## 影響

### Positive

- パスワードはCognitoだけが扱い、アプリとAPIは受け取らない。
- Cognito固有の実装が、各アプリの認証の部分と、APIの検証処理に閉じる。

### Negative / Trade-offs

- 受講生アプリの開発で、Expo Goが使えなくなる。ネイティブの依存を変えるたびにビルドし直す。
- Amplifyの既定のトークン保存先は、受講生アプリがAsyncStorage、管理画面がlocalStorageで、どちらも暗号化されない。保存先は差し替えられる（`setKeyValueStorage`）。受講生アプリはSecureStoreへの差し替えをPoCで確かめる。
- Amplify UIのデザインがSONOMAMAに合わなければ、管理画面も独自の画面に作り直す。

## 実装・運用への影響

- 受講生アプリ・管理画面にAmplifyのパッケージ、APIにJWTライブラリの依存が加わる。
- APIにユーザーのテーブルと`GET /api/v1/me`が加わり、MigrationとOpenAPIの変更になる。
- 環境ごとにUser PoolとApp Clientを管理する。
- 認証の実装になるため、SEC-AUTH-001の対象になる（[authorization.md](../security/authorization.md)）。

## 検証方法

- PoCで、両アプリからログインして`GET /api/v1/me`を呼べること、Expo SDK 58でAmplifyが動くことを確かめる。
- APIの認証テストで、設計文書に挙げた不正なトークンをすべて401にすることを確かめる。

## 再検討条件 / 撤回条件

- Expo SDKの更新で、Amplify Authが動かなくなったとき
- 受講生アプリで、トークンを暗号化された保存先に置けないと分かったとき
- 外部のIDでのログイン（ソーシャルログイン・SSO）が必要になったとき

## 関連資料

- [ADR-0007: インフラにAWS、認証基盤にAmazon Cognitoを使う](0007-aws-and-cognito.md)
- [ADR-0002: ユーザー登録をCS起点の招待制とする](0002-user-registration-and-invitation.md)
- [docs/architecture/authentication.md](../architecture/authentication.md)
- [Amplify（React Native）のQuickstart](https://docs.amplify.aws/react-native/start/quickstart/): Expo Goに対応しないこと
- [Amplifyのトークンの保存先](https://docs.amplify.aws/react-native/build-a-backend/auth/concepts/tokens-and-credentials/): Webの既定がlocalStorageであること、`setKeyValueStorage`で差し替えられること
- [amplify-jsのReact Native用の既定の保存先](https://github.com/aws-amplify/amplify-js/blob/main/packages/core/src/storage/DefaultStorage.native.ts): AsyncStorageを使うこと
- [Amplify UI Authenticator](https://ui.docs.amplify.aws/react/connected-components/authenticator/configuration)
- [Expo Development Builds](https://docs.expo.dev/develop/development-builds/faq/)
- [CognitoのAccess Token](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-the-access-token.html): APIの操作の認可に使うこと、`sub`でユーザーを特定すること、有効期間は5分〜1日でApp Clientごとに設定できること

ADRの状態を変えるのは人間だけ。AIだけで確定しない。

# OAuth の仕組み

この文書は OAuth モードの動作と運用上の詳細を説明します。接続手順は [クライアント接続](clients.md)、トークンの安全な保管と脅威境界は [セキュリティ](security.md) を参照してください。

## 全体像

MCP サーバーは OAuth 2.1 の認可コードフロー、PKCE、CIMD（Client ID Metadata Documents）および DCR（Dynamic Client Registration）を扱います。CIMD が利用できないクライアントでは DCR をフォールバックとして利用します。

MCP の URL は通常 `https://<公開ホスト>/mcp` です。OAuth の discovery、登録、認可、トークンの各エンドポイントも同じ HTTPS オリジン上で提供され、Caddy から同じ Node.js HTTP サーバーへ reverse proxy します。

## エンドポイント

- `GET /.well-known/oauth-protected-resource/mcp`
- `GET /.well-known/oauth-protected-resource`（互換用フォールバック）
- `GET /.well-known/oauth-authorization-server`
- `GET /.well-known/openid-configuration`
- `POST /register`（DCR）
- `GET /authorize`、`POST /authorize`
- `POST /token`
- `POST /revoke`

旧バージョンの `POST /login` は廃止されています。

認可コードフローでは PKCE `S256` を要求します。`resource` が指定された場合、MCP リソース URI（例: `https://<公開ホスト>/mcp`）と一致する必要があります。省略時は自サーバー扱いです。アクセストークンはリソース URI、有効期限、失効状態を検証します。リフレッシュトークンはローテーションし、使用済みトークンの再利用を検出すると同じ系列を失効させます。

## トークンの種類と用途

| 認証情報 | 用途 |
|---|---|
| OAuth access token | 認可済みの Web クライアントから MCP にアクセス |
| 静的トークン `purpose=login` | 新しいクライアントの同意画面で本人確認 |
| 静的トークン `purpose=api` | Claude Code、Cursor、Mistral AI、curl などの直接 Bearer 認証 |

`login` トークンは MCP API にアクセスできません。`api` トークンは OAuth 同意画面の本人確認には使えません。静的トークンは `npm run token -- create` で発行します。

## スコープ

| スコープ | 意味 | 付与方法 |
|---|---|---|
| `ocr:read` | OCR の検索・閲覧 | 常に付与 |
| `ocr:write` | 書き込み権限のためのスコープ | OAuth では要求された場合だけ同意画面にチェックボックスを表示（既定オフ）。静的トークンでは `--scope ocr:write` を明示した場合のみ |

`ocrWrite.enabled` が `false`（既定値）のとき、広告するスコープは `ocr:read` のみです。有効化時は `ocr:write` も広告され、同意画面で任意許可できます。`update_ocr_text` はツール実行時にも `authInfo.scopes` を確認します。スコープをトークンへ付与するだけでは書き込み認可は成立しません。未知のスコープは無視され、API トークンには `ocr:read` が常に付与されます。

## 同意画面とログイン制限

認可画面 (`/authorize`) はクライアントを許可するたびに `purpose=login` のトークンを要求します。ログインセッション Cookie はありません。拒否操作にはトークンは不要で、結果は `access_denied` としてリダイレクトされます。

- 入力ミスは接続元アドレス（`X-Forwarded-For` の末尾）ごとに15分間で10回まで。上限を超えると `429` を返します。
- 認可成功時は接続元、ログイン用トークン名、付与スコープをログに記録します。トークン本体は記録しません。
- アクセストークンの refresh にログイン用トークンは不要です。再度ログインが必要なのは新しい接続を許可するときです。
- DCR で登録したクライアント名は自己申告で未検証と表示します。CIMD では取得して検証したメタデータのホストを表示します。
- `POST /authorize` は期待する `Origin` を要求します。

## リダイレクト URI

`redirect_uri` はクライアント側のコールバック URI です。`oauth.allowedRedirectUris` に完全一致する URI のみ受け付けます（DCR・CIMD 共通）。許可 URI の origin は同意画面の CSP `form-action` にも追加されます。

ストア側でも URI の形式を検証します。

- HTTPS、または HTTP かつループバックホスト（`localhost`、`127.0.0.1`、`[::1]`）のみ。
- ユーザー情報やフラグメントを含む URI は拒否。値が空でも authority 内の `@` や末尾を含む `#` がある場合は拒否。
- `ftp://localhost/...` や `cursor://...` など別スキームやカスタムスキームは受け付けません。

クライアントごとの URI は実際に送信される値を確認して許可リストに追加します。URLのパス末尾のスラッシュも一致判定に影響します。

## CIMD と DCR

認可サーバーメタデータでは、`client_id_metadata_document_supported: true` と `token_endpoint_auth_methods_supported: ["none"]` の両方を広告します。CIMD クライアントは `client_id` として HTTPS URL を送信し、サーバーはその URL からメタデータ JSON を取得して検証します。

- 文書内の `client_id` が文書 URL と一致すること。
- `redirect_uris` は `oauth.allowedRedirectUris` に含まれるものを採用すること。
- 取得先ホストは `oauth.cimdAllowedHosts` に限定し、リダイレクトには追従しないこと（SSRF 対策）。

CIMD を利用できないクライアントは `/register` の DCR で登録します。DCR と CIMD のどちらも、許可されていない redirect URI は拒否します。

## 関連文書

- [セットアップ](setup.md)
- [セキュリティ](security.md)
- [トラブルシューティング](troubleshooting.md)


## 旧 `MCP_BEARER_TOKEN` 方式からの移行

旧バージョンでは `.env` の `MCP_BEARER_TOKEN` を同意画面のログイン秘密値として使用し、ログイン後は Cookie によって最大12時間再利用していました。現在のバージョンでは `MCP_BEARER_TOKEN` は認証に使用しません。値が残っていると起動時に警告が出るため、`.env` から削除してください。

移行時は OAuth モードの設定に `staticTokens.databasePath` を追加し、次のコマンドでログイン用トークンを発行します。

```bash
npm run token -- create --name owner --purpose login
```

旧ログインセッションはなくなり、OAuth DB 内の `oauth_login_sessions` テーブルは起動時に削除されます。既に発行済みの OAuth access token と refresh token は、その移行だけを理由には無効化されません。

# OCR MCP Server

既存の OCR SQLite データベースを MCP (Streamable HTTP) で検索・閲覧するサーバーです。既定では読み取り専用で動作し、`ocrWrite.enabled` を明示的に有効にした場合のみ、`ocr:write` 権限を持つ呼び出し元に未レビュー OCR 本文の更新を許可します。

## 必要な環境

- Node.js 22.16.0 以降。SQLite FTS5 が利用できるビルドが必要です。
- 既存 OCR データベースへの読み取りアクセス。書き込みはデフォルト無効で、明示的な有効化と `ocr:write` スコープが必要。
- 外部クライアントから接続する場合は、公開 HTTPS と MCP サーバーへの reverse proxy。

## クイックスタート（OAuth モードを推奨）

1. 設定例をコピーします。

   ```bash
   cp config/config.oauth.example.json config/config.json
   ```

2. `config/config.json` の `database.path`、`server.publicBaseUrl`、必要に応じて `server.allowedHosts` と `originalImages.rootPath` を実環境に合わせます。OAuth DB と静的トークン DB の保存先は、サーバー実行ユーザーがアクセスできるようにしてください。3つの DB パスは別々のファイルである必要があります。
3. 依存関係をインストールし、ビルドとテストを実行します。

   ```bash
   npm ci
   npm run build
   npm test
   ```

4. 同意画面で使うログイン用トークンを発行し、秘密の値を安全に保存します。

   ```bash
   npm run token -- create --name owner --purpose login
   ```

   Claude Code、Cursor、curl などから直接接続する場合は、別途 `--purpose api` のトークンを発行します。`login` トークンは MCP API への接続には使えません。
5. サーバーを起動します。

   ```bash
   npm start
   ```

   既定の待受先は `127.0.0.1:3001`、MCP のパスは `/mcp` です。外部公開時はポート 3001 を直接インターネットに公開せず、Caddy などで HTTPS reverse proxy を構成してください。
6. claude.ai の「設定 → コネクタ → カスタムコネクタを追加」で `https://<公開ホスト>/mcp` を登録します。OAuth Client ID / Secret は空欄のままにし、認可画面で `purpose=login` のトークンを入力します。

詳しい設定と Caddy の構成は [セットアップ](docs/setup.md)、クライアント別の手順は [クライアント接続](docs/clients.md) を参照してください。

## ドキュメント

| 文書 | 内容 |
|---|---|
| [セットアップ](docs/setup.md) | 設定ファイル、パス、ビルド・起動、Caddy |
| [クライアント接続](docs/clients.md) | claude.ai、Claude Code、Cursor、Mistral AI、curl |
| [運用](docs/operations.md) | DB、バックアップ、権限、起動時の劣化、復旧 |
| [OAuth の仕組み](docs/oauth.md) | エンドポイント、CIMD / DCR、PKCE、同意画面、スコープ |
| [セキュリティ](docs/security.md) | トークン管理、認証境界、ログ、ネットワーク上の注意 |
| [トラブルシューティング](docs/troubleshooting.md) | 401 / 429 / 503、FTS5、DB、Caddy、OAuth の障害対応 |
| [開発者向け情報](docs/development.md) | ソース構成、アーキテクチャ、型検査・ビルド・テスト |
| [日本語全文検索](docs/japanese-search.md) | sqlite-vaporetto の導入、専用インデックス構築、`search_ocr_japanese` |

## 認証について

`config/config.json` の `auth.mode` は必ず明示します。

- `"oauth"`: Web クライアント向け OAuth 2.1 (CIMD + DCR フォールバック + PKCE) と、名前付き静的 Bearer トークンを併用します。通常はこちらを推奨します。
- `"none"`: 認証なし。URL を知っていれば誰でも OCR を検索できるため、ローカルの動作確認などに限定し、インターネットへ公開しないでください。

## 現在の制約

`ocrWrite.enabled` はデフォルト `false` です。有効化時は `auth.mode: "oauth"` が必須です。`update_ocr_text` は `reviewed = 0` の行だけを更新し、NULL とその他の非ゼロ値は保護します。書き込み開始時には book-ocr が管理する `source_images_ai` / `source_images_ad` / `source_images_au` FTS 同期トリガーを検証します。MCP サーバーは book-ocr 管理の `source_images` / `images_fts` とそのトリガーを作成・変更しません（MCP 専用の `mcp_ocr_edit_history` は従来どおり MCP 側で管理します）。OCR 本文と専用履歴は同じ短いトランザクションで更新します。固定レート制限、リクエスト本文上限、履歴10 MiB警告などは [運用](docs/operations.md) と [セキュリティ](docs/security.md) を参照してください。

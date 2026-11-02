# トラブルシューティング

症状から確認します。起動時ログにはローカルパスや詳細な例外が含まれる場合があります。外部へログを共有する際は秘密情報や環境固有情報を確認してください。セキュリティ上の注意は [セキュリティ](security.md)、障害時の運用方針は [運用](operations.md) を参照してください。

## ビルド・起動

### `no such module: fts5` / `OCR database is unavailable`

Node.js のバージョンまたは SQLite ビルドで FTS5 が利用できない可能性があります。Node.js **22.16.0 以降**であることを確認し、FTS5 対応ビルドを使用します。OCR DB のスキーマ不一致や破損も同じように OCR 機能を劣化させます。起動ログの原因を確認してください。OCR 検索では FTS5 の trigram トークナイザを前提にしていますが、起動時検証はトークナイザの同一性そのものではなく、必要なテーブル・列、FTS5 仮想テーブルであること、`MATCH` クエリの実行可否を検証します。

```bash
node --version
npm run build
npm test
```

### `config/config.json` が見つからない、設定エラーで起動しない

- 設定例を `config/config.json` にコピーしたか確認します。
- 別のファイルを使う場合は `MCP_CONFIG_PATH` を確認します。
- `auth.mode` が明示されているか、パスが絶対パスか、OAuth モードの3つの DB パスが異なるファイルかを確認します。
- OAuth モードでは `server.publicBaseUrl`、`oauth.databasePath`、`staticTokens.databasePath` が必要です。

```bash
cp config/config.oauth.example.json config/config.json
```

このコマンドは既存の設定を上書きする可能性があるため、すでに `config/config.json` がある場合は先にバックアップしてください。

### `Forbidden test/support files in dist` または `dist check failed`

ビルド後の `dist/` にテストまたはテスト支援ファイルが含まれていないことを確認します。`src/` の削除済みファイルが古い作業ディレクトリに残っている場合は、不要な残存ファイルを確認してから `npm run build` を再実行してください。成果物の検査スクリプトを無効化して回避しないでください。

## HTTP と MCP

### `/mcp` が `401` を返す

OAuth モードでトークンが送られていない、無効、期限切れ、失効済み、または目的が違う可能性があります。直接 Bearer 認証では `purpose=api` のトークンを使用してください。401 の `WWW-Authenticate` ヘッダーに示される protected-resource metadata を確認します。

```bash
curl -i https://<公開ホスト>/mcp
```

未認証時に 401 が返ることは、OAuth モードでは異常とは限りません。

### `/mcp` が `503` を返す

認証に必要な DB や認証ゲートが利用できない可能性があります。ログの `[oauth]` 行を確認し、OAuth DB と静的トークン DB のパス、存在、権限、ファイルシステムの状態を確認します。認証障害時は無認証へ切り替わりません。起動時に開けなかった DB は、原因修正後にサーバーを再起動してください。

### ツール呼び出しが `isError: true` を返す

OCR DB または元画像ストレージの障害では、通常 HTTP 接続全体を 503 にせず、MCP のツール結果としてエラーを返します。ログにある詳細原因に応じて DB パス、列、FTS5、マウント状態を確認します。クライアントへはローカルパスやドライバの詳細が返らない設計です。

## OAuth

### 「Couldn't reach the MCP server」

- 公開 HTTPS と有効な証明書を確認します。
- `server.publicBaseUrl` と登録した MCP URL のホスト・パスを確認します。末尾スラッシュも含め、resource URI は一致する必要があります。
- `curl -i https://<公開ホスト>/mcp` が未認証時に 401 と適切な `WWW-Authenticate` を返すか確認します。
- `/.well-known/oauth-protected-resource/mcp` と `/.well-known/oauth-authorization-server` が外部から取得できるか確認します。
- WAF やネットワーク制限がクライアント側の接続を妨げていないか確認します。Anthropic 側の送信元 IP を固定リストで制限している場合は、現在の公式情報を確認してから許可リストを設定してください。

### 同意画面で「ログイン用トークンが正しくありません」

`purpose=login` のトークンか確認します。`purpose=api` は同意画面には使えません。`npm run token -- list` でトークンが active かを確認してください。

### 認可時に `429 Too many login attempts`

同じ接続元からのログイン失敗が制限値を超えています。現在の制限は15分で最大10回です。解除まで待つ間に、トークンの用途・入力値・接続元アドレスの扱いを確認してください。

### 許可後にクライアントへ戻らない

リダイレクト URI が `oauth.allowedRedirectUris` に完全一致で含まれるか確認してください。許可済み URI の origin は同意画面の CSP `form-action` に追加されます。Caddy 等の reverse proxy が CSP を上書きしていないかも確認します。

### CIMD / DCR 登録で拒否される

ログの `[oauth/cimd]` または `[oauth/register]` の拒否理由を確認します。主な条件は `client_id` と CIMD 文書 URL の一致、`oauth.cimdAllowedHosts`、`oauth.allowedRedirectUris` の許可リスト、HTTPS（またはループバック HTTP）の要件です。古い DCR 登録を完全に消す必要がある場合、OAuth DB を削除すると登録・トークン状態も失われます。静的トークン DB とは別ファイルなので、影響を理解してから実施してください。

## 元画像

### 画像ツールが利用できない

- `originalImages.rootPath` が絶対パスで、書籍別ディレクトリが直接並ぶ親ディレクトリを指しているか確認します。
- ディレクトリがマウント済みか、サービス実行ユーザーに読み取り権限があるか確認します。
- 元画像ストレージの障害はリクエストごとに再解決するため、後からマウントされれば次のリクエストで利用可能になる場合があります。
- 対応形式は PNG、JPEG、WebP、GIF、取得上限は1ファイル20 MiBです。
- 画像取得は1件ずつ FIFO で処理し、最大30件まで待機します。`Image retrieval queue is full` は待機上限に達した場合です。時間を置いて再試行するか、一度に要求する画像数を減らしてください。
- キュー待機と読み込みを合わせて180秒でタイムアウトします。クライアントがリクエストをキャンセルすると、待機中の要求はキューから除去されます。実行中の Worker がキャンセルに応答しない場合は10秒後に終了・再生成されます。

## 関連文書

- [セットアップ](setup.md)
- [運用](operations.md)
- [OAuth の仕組み](oauth.md)

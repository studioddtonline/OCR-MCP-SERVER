# セットアップ

この文書では OCR MCP Server を構築し、設定して起動するまでを説明します。クライアントへの登録は [クライアント接続](clients.md)、障害時の対処は [トラブルシューティング](troubleshooting.md) を参照してください。

## 1. 必要な環境

- Node.js **22.16.0 以降**。OCR 検索は SQLite FTS5 を必要とします。Node.js の `node:sqlite` はそれ以前でも存在する場合がありますが、FTS5 が利用できなければ OCR DB は使用不可になります。
- npm と、このリポジトリの `package-lock.json`。
- 既存 OCR SQLite DB。通常は読み取り専用で開きます。OCR 書き込み機能を明示的に有効化すると、同じ DB に書き込み用の別接続を開きます。
- 画像ツールを使う場合は、元画像を格納したディレクトリへのアクセス。

## 2. 設定ファイルを作る

OAuth を利用する場合：

```bash
cp config/config.oauth.example.json config/config.json
```

ローカルで認証なしの動作確認だけを行う場合：

```bash
cp config/config.example.json config/config.json
```

`auth.mode: "none"` は認証を行わず、URL に到達できる利用者が OCR データを検索できます。外部へ公開する構成では使用せず、OAuth モードを選んでください。

### 主な設定項目

| 設定 | 説明 |
|---|---|
| `server.host` | Node.js の待受アドレス。例は `127.0.0.1` |
| `server.port` | 待受ポート。例は `3001` |
| `server.mcpPath` | MCP エンドポイントのパス。既定例は `/mcp` |
| `server.publicBaseUrl` | OAuth と外部接続で使う HTTPS オリジン。パスを付けずに指定 |
| `server.allowedHosts` | 許可する Host 名。省略時は `publicBaseUrl` のホスト名を使う |
| `auth.mode` | `none` または `oauth`。明示指定が必要 |
| `database.path` | 既存 OCR SQLite DB の絶対パス |
| `ocrWrite.enabled` | OCR 本文の書き込み。既定 `false`。`true` にする場合は `auth.mode: "oauth"` が必須 |
| `database.busyTimeoutMs` | OCR DB の SQLite busy timeout（既定値 500 ms）。ロック競合時にイベントループを長く停止させないための初期値です。 |
| `originalImages.rootPath` | 書籍別ディレクトリが直接並ぶ親ディレクトリの絶対パス |
| `search.defaultLimit` | 検索結果の既定件数 |
| `search.maxLimit` | 検索結果件数の上限 |
| `search.snippetLength` | 検索スニペットの長さ |
| `oauth.databasePath` | OAuth のクライアント・認可コード・トークン DB |
| `oauth.allowedRedirectUris` | OAuth クライアントが使用できるリダイレクト URI の許可リスト |
| `oauth.cimdAllowedHosts` | CIMD メタデータ取得先として許可するホスト名 |
| `staticTokens.databasePath` | 静的トークン DB。OAuth モードではログイン用トークンも保存 |

`auth.mode: "oauth"` の場合、`oauth.databasePath`、`staticTokens.databasePath` と `database.path` は別々のファイルである必要があります。OAuth モードでは `server.publicBaseUrl` も必須です。OAuth・静的トークン DB の SQLite busy timeout も 500 ms とし、長時間の同期ロック待ちを避けます。

`publicBaseUrl` は HTTPS の origin（例: `https://ddns.s13e.net`）であり、パス、クエリ、認証情報は付けません。

`config/config.oauth.example.json` にあるドメイン、リダイレクト URI、保存パスは例です。利用するクライアントと実環境に合わせて確認してください。DB 保存先ディレクトリは、サーバー実行ユーザーがアクセスでき、他のユーザーから不用意に読めない権限にします。

### オリジナル画像

`originalImages.rootPath` は画像ファイルそのものではなく、書籍別ディレクトリが直接並ぶ親ディレクトリです。例えば次の配置です。

```text
/mnt/original-books/
├── 書籍A/
│   ├── 020.webp
│   └── 021.webp
└── 書籍B/
    └── 001.jpg
```

`rootPath` を省略または利用不能にしてもサーバー自体は起動しますが、元画像ツールは利用できません。画像取得は PNG、JPEG、WebP、GIF を対象とし、1ファイルあたりの上限は 20 MiB です。

## 3. 環境変数と `.env`

`.env` は必須ではありません。設定ファイルの場所を変える場合にのみ `MCP_CONFIG_PATH` を指定します。`.env` を利用する場合、すでに OS 環境変数に設定されている値は `.env` の値より優先されます。

```dotenv
MCP_CONFIG_PATH=/etc/ocr-mcp/config.json
```

`MCP_BEARER_TOKEN` は旧方式との互換診断用であり、現在の認証には使用されません。設定されていると警告が出るため、古い値が残っていれば削除してください。`.env.example` を必要に応じて参照してください。

## 4. インストール、ビルド、テスト、起動

リポジトリのルートで実行します。

```bash
npm ci
npm run build
npm test
npm start
```

主なスクリプト：

- `npm run build`: 型検査、`dist/` のクリーンアップ、ビルド、成果物の検査。
- `npm run typecheck`: テストを含む TypeScript の型検査。
- `npm test`: テストを実行。
- `npm start`: `dist/index.js` を起動。
- `npm run dev`: 開発モードで起動。
- `npm run token -- ...`: ビルド済みのトークン管理 CLI。
- `npm run token:dev -- ...`: 開発用トークン管理 CLI。

Node.js の `node:sqlite` に関する ExperimentalWarning が出る場合があります。FTS5 非対応などで OCR DB を開けない場合は [トラブルシューティング](troubleshooting.md) を参照してください。

## 5. トークン発行

OAuth 同意画面で本人確認に使うログイン用トークン：

```bash
npm run token -- create --name owner --purpose login
```

Claude Code、Cursor、curl などの MCP API 接続に使う静的 API トークン：

```bash
npm run token -- create --name claude-code --purpose api
```

トークンは発行時に一度だけ表示されます。安全なパスワードマネージャーなどに保存してください。トークンの一覧・失効・期限設定は [セキュリティ](security.md) を参照してください。

## 6. Caddy と HTTPS

プロジェクトルートの `Caddyfile` は例です。既存の `/etc/caddy/Caddyfile` を丸ごと上書きせず、必要なサイトブロックだけを統合します。

```caddyfile
ddns.s13e.net {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3001
}
```

`ddns.s13e.net` を実際のホスト名に置き換え、`server.publicBaseUrl` と `oauth.allowedRedirectUris` も利用環境に合わせます。OAuth の discovery、登録、認可、トークン、MCP の各パスは同じ Node.js HTTP サーバーへ到達させます。

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

外部クライアントから接続する場合、公開 HTTPS と有効な証明書が必要です。Node.js のポート `3001` をルーターから直接公開せず、Caddy の reverse proxy 経由にしてください。claude.ai などのクラウド側から接続する場合、LAN 内だけの URL では接続できません。CORS の追加設定は不要です。

## 次に読む文書

- [クライアント接続](clients.md)
- [運用](operations.md)
- [OAuth の仕組み](oauth.md)

# クライアント接続

MCP エンドポイントは通常 `https://<公開ホスト>/mcp` です。実際の値は `server.publicBaseUrl` と `server.mcpPath` に合わせてください。OAuth モードと静的 Bearer トークンでは接続手順が異なります。

## claude.ai（OAuth）

1. [セットアップ](setup.md)を済ませ、サーバーを起動して公開 HTTPS からアクセスできるようにします。
2. claude.ai の「設定 → コネクタ → カスタムコネクタを追加」を開きます。
3. MCP URL に `https://<公開ホスト>/mcp` を指定します。OAuth Client ID / Secret は空欄のままにします。
4. 認可画面で `purpose=login` のトークンを入力し、「許可する」を選びます。

`redirect_uri` はサーバー側の `oauth.allowedRedirectUris` に完全一致で登録されている必要があります。CIMD が利用できない場合は DCR にフォールバックします。詳細は [OAuth の仕組み](oauth.md)を参照してください。

claude.ai からの接続は Anthropic のクラウド側から行われます。MCP サーバーがインターネットから HTTPS で到達可能である必要があります。カスタムコネクタで任意のリクエストヘッダーを設定できない場合は、OAuth モードを使ってください。

## Claude Code（静的 API トークン）

最初に `purpose=api` のトークンを発行し、クライアントを実行する環境で設定します。

```bash
export OCR_MCP_TOKEN='ocrmcp_api_...'
claude mcp add --transport http ocr https://<公開ホスト>/mcp \
  --header "Authorization: Bearer $OCR_MCP_TOKEN"
```

`ocrmcp_api_...` はプレースホルダーです。実際のトークンに置き換えます。

## Cursor（静的 API トークン）

Cursor の MCP 設定 (`mcp.json`) で `Authorization` ヘッダーを設定します。

```json
{
  "mcpServers": {
    "ocr": {
      "url": "https://<公開ホスト>/mcp",
      "headers": {
        "Authorization": "Bearer ${env:OCR_MCP_TOKEN}"
      }
    }
  }
}
```

Cursor を起動する環境で `OCR_MCP_TOKEN` を設定してください。環境変数の展開方法は、利用中の Cursor の設定仕様に従います。

## Mistral AI のカスタムコネクタ（静的 API トークン）

MCP コネクタの認証方式で **Request Header** を選びます。

- Header name: `Authorization`
- Header value: `Bearer <発行した purpose=api トークン>`
- MCP URL: `https://<公開ホスト>/mcp`

`Bearer ` も必要です。トークンをプロンプトやチャット本文へ貼り付けないでください。

## curl で接続を確認

```bash
export OCR_MCP_TOKEN='ocrmcp_api_...'
curl -sS https://<公開ホスト>/mcp \
  -H "Authorization: Bearer $OCR_MCP_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_ocr_stats","arguments":{}}}'
```

成功すると `get_ocr_stats` の JSON-RPC 応答が返ります。`OCR_MCP_TOKEN` は必ず実際に発行したトークンに置き換えます。

## 提供される MCP ツール

### OCR

`search_ocr` は単純な文字列と構造化クエリの両方を受け付けます。複合条件は次のように指定します。

```json
{
  "query": {
    "type": "or",
    "nodes": [
      {
        "type": "and",
        "nodes": [
          { "type": "term", "value": "宮崎" },
          { "type": "term", "value": "監督" }
        ]
      },
      {
        "type": "and",
        "nodes": [
          { "type": "term", "value": "ラピュタ" },
          { "type": "not", "node": { "type": "term", "value": "劇場版" } }
        ]
      }
    ]
  }
}
```

これは `(宮崎 AND 監督) OR (ラピュタ AND NOT 劇場版)` を意味します。`term` の文字数に応じ、1〜2 Unicode コードポイントは大文字小文字を区別する部分文字列検索、3文字以上は trigram フレーズ検索で評価します。クエリ木は最大32ノード・8階層、各 AND／OR は2〜16子条件で、NOT のみの検索は拒否されます。

- `search_ocr`: OCR 本文の統合検索。`query` に文字列を指定すると単一語検索になり、1〜2 Unicode コードポイントは大文字小文字を区別するリテラル部分文字列検索、3文字以上は FTS5 trigram のフレーズ検索になります。`query` に構造化オブジェクトを指定すると AND／OR／NOT の複合検索ができます。構文は `term` (`{ "type": "term", "value": "宮崎" }`)、`and`／`or` (`{ "type": "and", "nodes": [...] }`)、`not` (`{ "type": "not", "node": {...} }`) です。任意の入れ子に対応しますが、最大32ノード・8階層・各AND/ORの子条件16個、各語500 Unicodeコードポイントまでです。NOTだけの検索は拒否します。各 `term` は長さに応じてリテラルまたは trigram で評価し、検索語を生の SQL／FTS5 構文として解釈しません。`label`／`reviewed` は式全体に適用されます。結果は ID 順で、深いページでは `afterId` に直前ページの `nextAfterId` を渡すキーセット方式を推奨します。`afterId` と正の `offset` は併用できません。次ページがなければ `nextAfterId` は `null` です。
- `get_ocr_record`: ID によるレコード取得。OCR 本文の返却長を制限できます。
- `list_source_labels`: 書籍ラベルと件数の一覧。取得上限は SQL 側で適用され、既定値は100件です。
- `get_ocr_stats`: 総件数とレビュー状態別件数。
- `update_ocr_text`: `ocrWrite.enabled: true` の場合のみ公開。`ocr:write` が必要で、未レビュー行の OCR 本文全体を置き換えます。`reviewed IS NOT 0` の行は変更できません。

### オリジナル画像

- `list_original_book_directories`: 画像ルート直下の書籍ディレクトリを列挙。
- `list_original_images`: 指定ディレクトリの画像ファイル名とサイズを列挙。`limit` は最大2000件で、後続ページは `nextOffset` を次回の `offset` に指定して取得できます。
- `get_original_image`: 指定画像を MCP の image content として返す。

OCR の `file_path` にある書籍ラベルと実際のディレクトリ名が一致するとは限らないため、対応付けはクライアント側で行います。画像ツールはファイル名・ディレクトリ名のみ受け付け、絶対パスや親ディレクトリへの移動は許可しません。

書き込みツールを使う前に管理者が `config/config.json` の `ocrWrite.enabled` を `true` にし、サーバーを再起動してください。書き込みを許可する静的 API トークンには `--scope ocr:write` を付けて発行するか、OAuth 同意画面で同スコープを明示的に許可します。

## 認証情報の使い分け

| トークン | 用途 | MCP API へのアクセス |
|---|---|---|
| `purpose=login` | OAuth 同意画面で本人確認 | 不可 |
| `purpose=api` | 静的 Bearer 認証 | 可。既定スコープは `ocr:read` |
| OAuth access token | 認可済み Web クライアント | 付与されたスコープに応じて可 |

トークンの発行、失効、有効期限、保管方法は [セキュリティ](security.md) を、接続に失敗した場合は [トラブルシューティング](troubleshooting.md) を参照してください。

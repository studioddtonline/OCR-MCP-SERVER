# 日本語全文検索

日本語全文検索の実装は [OCR-SEARCH](https://github.com/studioddtonline/OCR-SEARCH) が所有します。MCP サーバー側は `search_ocr_japanese` ツール、設定、認証境界だけを担当し、トークナイザー、専用 FTS5 インデックス、Worker、検索ロジックを重複実装しません。

## 1. ネイティブ拡張の導入

OCR-MCP-SERVER のプロジェクトルートで実行します。

```bash
npm ci
npm run japanese-search:install
npm run japanese-search:check
```

インストーラーは upstream の sqlite-vaporetto v0.4.0 を SHA-256 検証して導入します。Linux x86_64 / aarch64 に対応します。標準の導入先は次のとおりです。

```text
native/sqlite-vaporetto/libsqlite_vaporetto.so
```

モデル同梱版を利用するため、別途 Vaporetto モデルファイルを指定する必要はありません。ネイティブ拡張とモデルのライセンス通知は、導入先に保持してください。

## 2. 設定

`config/config.json` に以下を設定します。パスは絶対パスで指定してください。

```json
"japaneseSearch": {
  "enabled": true,
  "indexPath": "/absolute/path/ocr-japanese-search.sqlite",
  "extensionPath": "/absolute/path/ocr-mcp-server/native/sqlite-vaporetto/libsqlite_vaporetto.so",
  "busyTimeoutMs": 500,
  "maxLimit": 20
}
```

`indexPath` は OCR DB、OAuth DB、静的トークン DB と別ファイルにします。`enabled` は既定で `false` です。

## 3. 専用インデックスの構築

OCR-SEARCH の Builder を呼び出します。MCP サーバーは設定ファイルを Builder に読ませず、すべてのパスを明示します。

```bash
npm run japanese-search:index -- \
  --database=/absolute/path/ocr.sqlite \
  --index=/absolute/path/ocr-japanese-search.sqlite \
  --extension=/absolute/path/ocr-mcp-server/native/sqlite-vaporetto/libsqlite_vaporetto.so \
  --busy-timeout-ms=500
```

Builder は元の OCR DB を読み取り専用で開き、一貫した読み取りスナップショットから専用 SQLite DB をステージングファイルへ構築します。Vaporetto で分かち書きした語を FTS5 unicode61 インデックスへ格納し、OCR 本文と表示用メタデータも専用 DB に保持します。元の OCR DB や `images_fts` は変更しません。

構築中は CPU とディスクを使用します。ロールバックジャーナルモードでは読み取りスナップショットが元 DB への書き込みを遅らせる場合があるため、初回構築や再構築は OCR の大量書き込みがない時間帯に行ってください。Builder はステージング DB の検証後に置き換えるため、構築失敗時は既存インデックスを維持します。

## 4. MCP サーバーの再起動

インデックス構築後に MCP サーバーを再起動します。`japaneseSearch.enabled` が `true` の場合に `search_ocr_japanese` が登録されます。

OCR-SEARCH が専用 Worker でネイティブ拡張と Vaporetto を初期化します。モデル初期化は数秒以上かかる場合があります。Worker は FIFO で検索を処理し、起動・キュー待機・実行にそれぞれ上限を設けています。Worker の起動や検索に失敗した場合、日本語検索は安全側に失敗します。日本語インデックスが利用不能でも、標準検索は利用可能なままです。

## 5. 検索仕様と鮮度

- `mode=any` は検索語から得たトークンのいずれかに一致、`mode=all` はすべてに一致します。
- `label` と `reviewed` のフィルターは検索時点の OCR DB の値に適用します。
- 結果の OCR 本文、ラベル、ファイル名、レビュー状態も現在の OCR DB から取得します。
- 候補 ID と BM25 順位は専用インデックスのスナップショットに基づきます。
- OCR レコードの追加や本文変更は自動でインデックスへ反映されません。新規レコードや変更後の本文を検索対象にするには再構築が必要です。
- インデックスを置き換えた後は MCP サーバーを再起動してください。実行中の Worker は既存の SQLite 接続を保持します。

日本語検索は文字単位の部分一致ではなく、Vaporetto による形態素・単語トークン検索です。1〜2文字の任意部分文字列検索が必要な場合は `search_ocr` を使用してください。標準検索と日本語検索は検索方式、ランキング、ページング仕様が異なります。

## 6. 再構築

OCR レコードの追加、OCR 本文の変更、レビュー状態の変更、または元 DB スキーマの変更後に再構築します。

```bash
npm run japanese-search:index -- \
  --database=/absolute/path/ocr.sqlite \
  --index=/absolute/path/ocr-japanese-search.sqlite \
  --extension=/absolute/path/ocr-mcp-server/native/sqlite-vaporetto/libsqlite_vaporetto.so
```

再構築後は MCP サーバーを再起動します。詳細な Worker ライフサイクル、検索入力、スナップショットの制約は [OCR-SEARCH の日本語検索ドキュメント](https://github.com/studioddtonline/OCR-SEARCH/blob/main/docs/japanese-search.md) を参照してください。

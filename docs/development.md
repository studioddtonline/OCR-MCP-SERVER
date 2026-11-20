# 開発者向け情報

サポート対象の Node.js は **24.0.0 以降**です。Node 22 のサポートは終了しました。GitHub Actions では Node.js 24.x / 26.x でテストとビルドを実行します。

P4-lite で整理したモジュール構成、ビルド、テスト、依存ルールを説明します。運用者向けの設定は [セットアップ](setup.md)、サービス障害は [トラブルシューティング](troubleshooting.md) を参照してください。

## 開発コマンド

```bash
npm ci
npm run typecheck
npm run build
npm test
npm run dev
```

- `npm run typecheck`: テストを含む TypeScript の型検査。
- `npm run build`: 型検査、`dist/` の掃除、本番 TypeScript のビルド、成果物の混入検査。
- `npm test`: `src/**/*.test.ts` のテストを実行。`test/support/` は共有テストヘルパーです。
- `npm run dev`: `src/index.ts` を開発モードで起動。
- `npm run token -- ...`: ビルド済み CLI。開発時は `npm run token:dev -- ...` を使えます。

## ソース構成

- `src/index.ts`: サーバーの既存エントリーポイント。
- `src/app/`: 起動時の組み立て、リソースの寿命、終了処理。
- `src/features/ocr/`: OCR DB の読み取り専用接続、書き込み用の別接続、スキーマ検証、非検索 Repository と OCR ツール。
- `ocr-search` npm dependency: 標準・日本語検索の意味論、クエリ AST の完全検証、SQL、スニペット、Vaporetto インデックスと Worker、検索 CLI / Builder を所有します。MCP は検索 API のアダプターと入力スキーマだけを持ちます。
- `src/features/japanese-search/`: OCR-SEARCH の日本語検索 API を MCP ツールとして公開する薄いアダプター。
- `src/features/original-images/`: 元画像ストレージの検証、画像 Repository と画像ツール。画像ファイルの読み込み・Base64 化は専用 Worker に分離します。FIFO キューは Runtime が所有する `OriginalImageRepository` のインスタンスに属し、リクエストごとに作られる MCP サーバーへ同じ Repository を注入して共有します。
- `src/mcp/`: MCP サーバーと機能ツールの登録を組み立てる層。
- `src/http/`: HTTP ルーティング、認証ゲート、OAuth ハンドラー。
- `src/auth/`: Bearer トークン、OAuth ストア、スコープ、OAuth ルート。
- `src/config/`: v1 設定のセクションスキーマ、読み込み、横断検証。設定形式は v1 のままです。
- `src/shared/`: 共通エラー処理と MCP ツール結果の生成。
- `test/support/`: テスト用フィクスチャ、サーバーヘルパー、一時ディレクトリ、OAuth テスト補助。
- `scripts/`: ビルド成果物のクリーンアップ・検査。

## SQL と Prepared Statement の扱い

SQL は、それを実行する Repository / Store の近くに名前付き定数として置きます。検索 SQL と Prepared Statement の LRU 管理は OCR-SEARCH が所有し、MCP 側の OCR Repository は検索 SQL を持ちません。OAuth のアクセストークン検証と静的トークン検証のように SQL の形が固定されたホットパスでは、汎用 Map ではなく名前付き Prepared Statement を接続ごとに一度だけ prepare して再利用します。

テストのためだけに必要な SQLite 拡張ロードなどの補助コードは `test/support/` に置き、本番ビルド対象の `src/features/` には置きません。

## コメントの言語方針

説明コメントと設計判断の理由は日本語を基本とします。識別子、API 名、標準仕様の用語、引用したエラー文などは英語のままで構いません。既存コメントを一括翻訳する必要はなく、新規・変更箇所からこの方針を適用します。

## アーキテクチャ上のルール

- `features/` は `app/`、`http/`、`mcp/` の組み立て層や旧 `data/` に依存しません。
- OCR 機能は元画像機能の実装詳細に依存せず、その逆も同様です。
- `app/` は機能を組み立てますが、HTTP や MCP の実装詳細に依存しません。
- `mcp/` は HTTP や `app/` に逆依存しません。
- `http/` は `features/` の実装を直接参照せず、MCP・認証の接続点を通じて処理を委譲します。
- `config/` は機能実装やランタイム層から独立しています。
- 本番ソースに相対 import の循環を作らないでください。
- 機能モジュールには `AppConfig` 全体ではなく、その機能に必要な狭いオプション型を渡します。

これらの境界は `src/architecture.test.ts` で検証します。意図的な依存変更が必要な場合は、まず責務と依存方向を再検討し、例外を安易に許可するのではなく、設計とテストを合わせて更新してください。

## ビルド成果物と公開契約

ビルド後の `dist/` にテストやテスト支援ファイルを含めないことを `scripts/check-dist.mjs` で検査します。`src/index.ts` は `dist/index.js`、`src/cli/tokens.ts` は `dist/cli/tokens.js` となる配置を維持します。

リファクタリングでは、以下を保護対象として扱います。

- 設定 v1 のキーと既定設定ファイル `config/config.json`。
- エントリーポイントと npm スクリプト（特に `dist/index.js`、`dist/cli/tokens.js`、`npm run token`）。
- HTTP パスとメソッド、ステータス、ヘッダー、エラーコード。
- MCP ツール名、説明、入力スキーマ、`isError` と HTTP 503 の使い分け。
- OAuth・静的トークン DB のテーブル、トークン接頭辞。

`search_ocr.query` の公開 JSON Schema は `$defs` / `$ref` で再帰 AST（term / and / or / not）を表します。一方、実行時の Zod スキーマは深い入力を再帰パースしない浅い envelope 検証を行い、ノード数・階層数・子数・term 長は `parseSearchQuery()` が反復処理で検査します。この二層構造は意図した設計です。AST の公開形を変更する場合は、`tools/list` の JSON Schema 検査と実行時検証をセットで更新してください。

## 現在の機能制約

日本語検索 Worker は、待機中の検索要求または `OcrSearch.ready()` の呼び出しがある場合に自動復旧します。起動前の Worker `error`、予期しない `exit`、起動タイムアウトは、その待機要求を需要として同じ再起動予算を共有し、指数バックオフ（既定 250 ms から最大 8 秒）で最大 5 回まで再試行します。`ready` 到達で起動失敗カウンターをリセットし、待機中の `ready()` は resolve します。`startup-error`（インデックスの読み込み・検証などの決定的な失敗）は再試行せず、待機中の要求を失敗させます。再起動上限到達時も待機中の要求は失敗します。実行タイムアウトや `ready` 後の異常終了は起動時の再試行予算を消費せず、次の要求があれば Worker を再生成します。`OcrSearch.ready()` は日本語検索が無効なら直ちに resolve し、Repository の `close()` 後は reject します。MCP は起動時に `ready()` を await しないため、HTTP サーバーの起動はモデル初期化を待ちません。検索要求のキュー待機期限は投入時から最大 180 秒、実行時間のタイムアウトは Worker の `started` 通知後に計測します。

元画像 Worker は `src/shared/worker-host.ts` の共通ホストで生成・世代識別・ready Promise・`message` / `error` / `exit` の監視・起動タイムアウト・冪等な終了・`ref()` / `unref()` を共有します。日本語検索 Worker のライフサイクルは OCR-SEARCH が所有し、MCP はその Worker 実装に依存しません。

OCR 書き込みは `ocrWrite.enabled` が `true` の場合だけ登録します。`auth.mode: "oauth"` が必要で、ツール内でも `authInfo.scopes` の `ocr:write` を検査します。書き込み Repository は読み取り Repository と別接続を使います。

`reviewed` は `0` だけを未レビュー・書き込み可能と扱います。`1`、その他の非ゼロ値、NULL はレビュー済み／保護対象です。検索・統計・書き込み・日本語検索で同じ意味を使います。OCR 書き込みを有効にする場合、book-ocr が管理する `source_images_ai` / `source_images_ad` / `source_images_au` の FTS 同期トリガーを起動時に検証します。MCP サーバーは book-ocr 管理の `source_images` / `images_fts` とその FTS トリガーを変更しません。MCP 専用の `mcp_ocr_edit_history` は引き続き MCP 側で作成・管理します。

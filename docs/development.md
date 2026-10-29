# 開発者向け情報

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
- `src/features/ocr/`: OCR DB の読み取り専用接続、書き込み用の別接続、スキーマ検証、Repository と OCR ツール。
- `src/features/original-images/`: 元画像ストレージの検証、画像 Repository と画像ツール。
- `src/mcp/`: MCP サーバーと機能ツールの登録を組み立てる層。
- `src/http/`: HTTP ルーティング、認証ゲート、OAuth ハンドラー。
- `src/auth/`: Bearer トークン、OAuth ストア、スコープ、OAuth ルート。
- `src/config/`: v1 設定のセクションスキーマ、読み込み、横断検証。設定形式は v1 のままです。
- `src/shared/`: 共通エラー処理と MCP ツール結果の生成。
- `test/support/`: テスト用フィクスチャ、サーバーヘルパー、一時ディレクトリ、OAuth テスト補助。
- `scripts/`: ビルド成果物のクリーンアップ・検査。

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

## 現在の機能制約

OCR 書き込みは `ocrWrite.enabled` が `true` の場合だけ登録します。`auth.mode: "oauth"` が必要で、ツール内でも `authInfo.scopes` の `ocr:write` を検査します。書き込み Repository は読み取り Repository と別接続を使います。

import { DatabaseSync } from "node:sqlite";
import { accessSync, constants } from "node:fs";

/** OcrRepository の SQL が実際に参照する source_images の列。 */
export const REQUIRED_SOURCE_IMAGE_COLUMNS = ["id", "file_path", "file_name", "ocr_text", "reviewed"] as const;

/**
 * 起動時のスキーマ検証 (DB は変更しない)。ツールが実行時に依存するものだけを、厳密に確認する。
 *   1. source_images / images_fts が存在する
 *   2. source_images に必須列がそろっている
 *   3. images_fts が FTS5 の仮想テーブルである
 *   4. 検索 (search_ocr) と同じ形の MATCH クエリが実際に通る
 * 起動時に開けなかった DB は再起動まで復旧しないため、実際には動く DB を誤って弾かないよう、
 * コードが依存しない条件 (特定のトークナイザなど) は課さない。
 * 失敗時のメッセージはサーバーログ専用 (クライアントには返さない)。
 */
export function validateOcrSchema(db: DatabaseSync): void {
  const tables = db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('source_images', 'images_fts')"
  ).all() as Array<{ name: string; sql: string | null }>;
  const sqlByName = new Map(tables.map((row) => [row.name, row.sql ?? ""]));
  if (!sqlByName.has("source_images") || !sqlByName.has("images_fts")) {
    throw new Error("Database must contain source_images and images_fts");
  }

  const columns = new Set(
    (db.prepare("PRAGMA table_info(source_images)").all() as Array<{ name: string }>).map((row) => row.name.toLowerCase())
  );
  const missing = REQUIRED_SOURCE_IMAGE_COLUMNS.filter((column) => !columns.has(column));
  if (missing.length > 0) {
    throw new Error(`source_images is missing required column(s): ${missing.join(", ")}`);
  }

  if (!/^\s*CREATE\s+VIRTUAL\s+TABLE\b[\s\S]*?\bUSING\s+fts5\b/i.test(sqlByName.get("images_fts")!)) {
    throw new Error("images_fts must be an FTS5 virtual table (CREATE VIRTUAL TABLE ... USING fts5)");
  }

  try {
    db.prepare("SELECT rowid FROM images_fts WHERE images_fts MATCH ? LIMIT 1").get('"abc"');
  } catch (error) {
    throw new Error("images_fts cannot be queried with MATCH", { cause: error });
  }
}

export interface OcrDatabaseOptions {
  path: string;
  busyTimeoutMs: number;
}

/** Opens only the OCR database, using the narrow options this feature actually needs. */
export function openReadOnlyDatabase(options: OcrDatabaseOptions): DatabaseSync {
  accessSync(options.path, constants.R_OK);
  const db = new DatabaseSync(options.path, {
    readOnly: true,
    timeout: options.busyTimeoutMs
  });

  try {
    validateOcrSchema(db);
    return db;
  } catch (error) {
    try { db.close(); } catch { /* Preserve the original open/schema error. */ }
    throw error;
  }
}

import type { DatabaseSync } from "node:sqlite";
import { ClientSafeError } from "../../shared/errors.js";
import { reviewedSqlPredicate } from "./reviewed.mjs";

const OCR_SQL = {
  getById: `
    SELECT id, file_path, file_name, reviewed, ocr_text
    FROM source_images WHERE id = ?
  `,
  listLabels: `
    SELECT file_path AS label, COUNT(*) AS count
    FROM source_images
    WHERE file_path IS NOT NULL AND file_path <> ''
    GROUP BY file_path
    ORDER BY file_path COLLATE NOCASE
    LIMIT ?
  `,
  getStats: `
    SELECT COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN ${reviewedSqlPredicate("reviewed", true)} THEN 1 ELSE 0 END), 0) AS reviewed,
           COALESCE(SUM(CASE WHEN ${reviewedSqlPredicate("reviewed", false)} THEN 1 ELSE 0 END), 0) AS unreviewed,
           COUNT(DISTINCT CASE WHEN file_path IS NOT NULL AND file_path <> '' THEN file_path ELSE NULL END) AS labels
    FROM source_images
  `,
} as const;

function safeSlice(text: string, end: number): string {
  let boundary = Math.max(0, Math.min(text.length, end));
  if (boundary > 0 && boundary < text.length) {
    const before = text.charCodeAt(boundary - 1);
    const after = text.charCodeAt(boundary);
    if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) boundary -= 1;
  }
  return text.slice(0, boundary);
}

export interface OcrRecord {
  id: number;
  file_path: string | null;
  file_name: string | null;
  reviewed: number | null;
  snippet: string;
  ocr_text: string;
  truncated: boolean;
}

/** Owns non-search OCR reads only. Search semantics are implemented by the ocr-search package. */
export class OcrRepository {
  private readonly prepared = new Map<string, ReturnType<DatabaseSync["prepare"]>>();
  constructor(private readonly db: DatabaseSync | undefined, private readonly unavailableReason?: string) {}

  getById(id: number, maxTextLength: number): OcrRecord | null {
    const row = this.statement(OCR_SQL.getById).get(id) as {
      id: number; file_path: string | null; file_name: string | null;
      reviewed: number | null; ocr_text: string | null;
    } | undefined;
    if (!row) return null;
    const fullText = row.ocr_text ?? "";
    const truncated = fullText.length > maxTextLength;
    const ocrText = safeSlice(fullText, maxTextLength);
    return {
      id: row.id,
      file_path: row.file_path,
      file_name: row.file_name,
      reviewed: row.reviewed,
      snippet: safeSlice(fullText, Math.min(160, ocrText.length)),
      ocr_text: ocrText,
      truncated,
    };
  }

  listLabels(limit = 100): Array<{ label: string; count: number }> {
    const rows = this.statement(OCR_SQL.listLabels).all(limit) as Array<{ label: string; count: number }>;
    // node:sqlite returns null-prototype row objects; expose ordinary objects at the repository boundary.
    return rows.map((row) => ({ label: row.label, count: row.count }));
  }

  getStats(): { total: number; reviewed: number; unreviewed: number; labels: number } {
    const row = this.statement(OCR_SQL.getStats).get() as {
      total: number; reviewed: number; unreviewed: number; labels: number;
    };
    return { ...row };
  }

  close(): void {
    this.prepared.clear();
    // The database connection is owned by the application bootstrap.
  }

  private statement(sql: string): ReturnType<DatabaseSync["prepare"]> {
    if (!this.db) throw new ClientSafeError("OCR database is unavailable", { cause: new Error(this.unavailableReason ?? "database unavailable") });
    let statement = this.prepared.get(sql);
    if (statement) {
      this.prepared.delete(sql);
      this.prepared.set(sql, statement);
      return statement;
    }
    if (this.prepared.size >= 16) {
      const oldest = this.prepared.keys().next().value;
      if (oldest !== undefined) this.prepared.delete(oldest);
    }
    statement = this.db.prepare(sql);
    this.prepared.set(sql, statement);
    return statement;
  }
}

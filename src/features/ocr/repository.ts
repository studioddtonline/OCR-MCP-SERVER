import type { DatabaseSync } from "node:sqlite";
import { ClientSafeError } from "../../shared/errors.js";

export interface SearchOptions {
  query: string;
  label?: string;
  reviewed?: boolean;
  limit: number;
  offset: number;
  afterId?: number;
  snippetLength: number;
}

export interface OcrHit {
  id: number;
  file_path: string | null;
  file_name: string | null;
  reviewed: number;
  snippet: string;
}

function makeSnippet(text: string | null, query: string, maxLength: number): string {
  if (!text) return "";
  const index = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (index < 0) return text.slice(0, maxLength);
  const start = Math.max(0, index - Math.floor(maxLength / 3));
  const end = Math.min(text.length, start + maxLength);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

export class OcrRepository {
  // SQL shapes used here are a bounded set of search-filter/cursor combinations plus the other
  // read methods. Reuse prepared statements for this repository's lifetime.
  private readonly preparedStatements = new Map<string, ReturnType<DatabaseSync["prepare"]>>();

  constructor(
    private readonly db: DatabaseSync | undefined,
    private readonly unavailableReason = "OCR database is unavailable",
  ) {}

  private statement(sql: string): ReturnType<DatabaseSync["prepare"]> {
    const db = this.database();
    let statement = this.preparedStatements.get(sql);
    if (!statement) {
      statement = db.prepare(sql);
      this.preparedStatements.set(sql, statement);
    }
    return statement;
  }

  private database(): DatabaseSync {
    // 原因 (ローカルパスを含みうる) は cause に残してログ専用にし、メッセージは固定文言にする。
    if (!this.db) throw new ClientSafeError("OCR database is unavailable", { cause: new Error(this.unavailableReason) });
    return this.db;
  }

  search(options: SearchOptions): { results: OcrHit[]; returned: number; offset: number; limit: number; nextAfterId: number | null } {
    const query = options.query.trim();
    if (Array.from(query).length < 3) {
      throw new ClientSafeError("Search query must contain at least 3 Unicode code points for trigram FTS search.");
    }
    if (options.afterId !== undefined && options.offset !== 0) {
      throw new ClientSafeError("Use afterId or offset for search pagination, not both.");
    }
    // Quote the input as an FTS phrase; embedded quotes are doubled.
    const ftsPhrase = `"${query.replaceAll('"', '""')}"`;
    // Driving the query from FTS5 lets SQLite stream rowids in order and stop at LIMIT,
    // rather than first materializing every matching rowid in an IN subquery.
    const clauses = ["images_fts MATCH ?"];
    const params: Array<string | number> = [ftsPhrase];

    if (options.label !== undefined) {
      clauses.push("si.file_path = ?");
      params.push(options.label);
    }
    if (options.reviewed !== undefined) {
      clauses.push("si.reviewed = ?");
      params.push(options.reviewed ? 1 : 0);
    }
    if (options.afterId !== undefined) {
      clauses.push("images_fts.rowid > ?");
      params.push(options.afterId);
    }

    // Fetch one sentinel row so nextAfterId is only returned when another page exists.
    params.push(options.limit + 1);
    const offsetClause = options.afterId === undefined ? "OFFSET ?" : "";
    if (options.afterId === undefined) params.push(options.offset);
    const sql = `
      SELECT si.id, si.file_path, si.file_name, si.reviewed, si.ocr_text
      FROM images_fts
      JOIN source_images AS si ON si.id = images_fts.rowid
      WHERE ${clauses.join(" AND ")}
      ORDER BY images_fts.rowid
      LIMIT ? ${offsetClause}
    `;
    const rows = this.statement(sql).all(...params) as Array<{
      id: number; file_path: string | null; file_name: string | null;
      reviewed: number; ocr_text: string | null;
    }>;
    const hasMore = rows.length > options.limit;
    const pageRows = hasMore ? rows.slice(0, options.limit) : rows;
    const results = pageRows.map((row) => ({
      id: row.id,
      file_path: row.file_path,
      file_name: row.file_name,
      reviewed: row.reviewed,
      snippet: makeSnippet(row.ocr_text, query, options.snippetLength)
    }));
    const nextAfterId = hasMore && results.length > 0 ? results[results.length - 1]!.id : null;
    return { results, returned: results.length, offset: options.offset, limit: options.limit, nextAfterId };
  }

  getById(id: number, maxTextLength: number): (OcrHit & { ocr_text: string; truncated: boolean }) | null {
    const row = this.statement(`
      SELECT id, file_path, file_name, reviewed, ocr_text
      FROM source_images WHERE id = ?
    `).get(id) as {
      id: number; file_path: string | null; file_name: string | null;
      reviewed: number; ocr_text: string | null;
    } | undefined;
    if (!row) return null;
    const fullText = row.ocr_text ?? "";
    const truncated = fullText.length > maxTextLength;
    return {
      id: row.id,
      file_path: row.file_path,
      file_name: row.file_name,
      reviewed: row.reviewed,
      snippet: fullText.slice(0, Math.min(160, maxTextLength)),
      ocr_text: fullText.slice(0, maxTextLength),
      truncated
    };
  }

  listLabels(limit = 100): Array<{ label: string; count: number }> {
    return this.statement(`
      SELECT file_path AS label, COUNT(*) AS count
      FROM source_images
      WHERE file_path IS NOT NULL AND file_path <> ''
      GROUP BY file_path
      ORDER BY file_path COLLATE NOCASE
      LIMIT ?
    `).all(limit) as Array<{ label: string; count: number }>;
  }

  getStats(): {
    total: number;
    reviewed: number;
    unreviewed: number;
    labels: number;
  } {
    // Combine all statistics into one aggregate so source_images only needs one table-level pass.
    // COUNT(DISTINCT ...) still performs duplicate-elimination work, but avoids a separate SELECT/scan.
    const row = this.statement(`
      SELECT COUNT(*) AS total,
             COALESCE(SUM(CASE WHEN reviewed <> 0 THEN 1 ELSE 0 END), 0) AS reviewed,
             COALESCE(SUM(CASE WHEN reviewed = 0 OR reviewed IS NULL THEN 1 ELSE 0 END), 0) AS unreviewed,
             COUNT(DISTINCT CASE
               WHEN file_path IS NOT NULL AND file_path <> '' THEN file_path
               ELSE NULL
             END) AS labels
      FROM source_images
    `).get() as { total: number; reviewed: number; unreviewed: number; labels: number };
    // node:sqlite returns rows with a null prototype; expose a plain object as before.
    return { ...row };
  }
}

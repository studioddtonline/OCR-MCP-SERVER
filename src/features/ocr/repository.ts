import type { DatabaseSync } from "node:sqlite";
import { ClientSafeError } from "../../shared/errors.js";
import { reviewedSqlPredicate } from "./reviewed.mjs";
import {
  compileQuery,
  extractPositiveTerms,
  parseSearchQuery,
  type QueryNode,
} from "./query.js";

export interface SearchOptions {
  query: unknown;
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
  reviewed: number | null;
  snippet: string;
}

const MAX_PREPARED_STATEMENTS = 64;

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
           COUNT(DISTINCT CASE
             WHEN file_path IS NOT NULL AND file_path <> '' THEN file_path
             ELSE NULL
           END) AS labels
    FROM source_images
  `,
} as const;

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

/** Return UTF-16 boundaries that never split a supplementary-plane character. */
function safeSliceBounds(text: string, requestedStart: number, requestedEnd: number, expandEnd: boolean): [number, number] {
  let start = Math.max(0, Math.min(text.length, requestedStart));
  let end = Math.max(start, Math.min(text.length, requestedEnd));
  const splitsStartPair =
    start > 0 && start < text.length &&
    isHighSurrogate(text.charCodeAt(start - 1)) && isLowSurrogate(text.charCodeAt(start));
  const splitsEndPair =
    end > 0 && end < text.length &&
    isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end));
  if (splitsStartPair) start -= 1;
  if (splitsEndPair) end += expandEnd ? 1 : -1;
  return [start, end];
}

/** Slice without returning half a surrogate pair; max-length reads back off, snippets may expand by one unit. */
function safeSlice(text: string, requestedStart: number, requestedEnd: number, expandEnd = false): string {
  const [start, end] = safeSliceBounds(text, requestedStart, requestedEnd, expandEnd);
  return text.slice(start, end);
}

/**
 * Build the lowercased text once per snippet. Most strings keep the same UTF-16 length,
 * so their offsets can be reused directly; allocate a source-offset map only when a
 * character expansion (such as İ -> i + combining dot) changes the folded length.
 */
function createCaseInsensitiveLookup(text: string): (term: string) => number {
  const foldedText = text.toLowerCase();
  if (foldedText.length === text.length) {
    // 通常の文字列では UTF-16 オフセットがそのまま使えるため、対応表を作らない。
    return (term: string): number => foldedText.indexOf(term.toLowerCase());
  }

  // 大文字小文字変換で UTF-16 長が変わる場合だけ、元文字列の位置対応表を作る。
  const sourceStartByFoldedUnit: number[] = [];
  let sourceOffset = 0;

  for (const character of text) {
    const foldedCharacter = character.toLowerCase();
    for (let index = 0; index < foldedCharacter.length; index += 1) {
      sourceStartByFoldedUnit.push(sourceOffset);
    }
    sourceOffset += character.length;
  }

  return (term: string): number => {
    const foldedIndex = foldedText.indexOf(term.toLowerCase());
    return foldedIndex < 0 ? -1 : (sourceStartByFoldedUnit[foldedIndex] ?? -1);
  };
}

function makeSnippet(text: string | null, queryTerms: string[], maxLength: number): string {
  if (!text) return "";
  const matches = queryTerms
    .map((term) => ({ term, index: text.indexOf(term) }))
    .filter((match) => match.index >= 0)
    .sort((a, b) => a.index - b.index || b.term.length - a.term.length);

  let index = matches[0]?.index ?? -1;
  if (index < 0 && queryTerms.length > 0) {
    const findCaseInsensitive = createCaseInsensitiveLookup(text);
    for (const term of queryTerms) {
      const candidate = findCaseInsensitive(term);
      if (candidate >= 0 && (index < 0 || candidate < index)) index = candidate;
    }
  }
  if (index < 0) return safeSlice(text, 0, maxLength, true);

  const start = Math.max(0, index - Math.floor(maxLength / 3));
  const end = Math.min(text.length, start + maxLength);
  const [safeStart, safeEnd] = safeSliceBounds(text, start, end, true);
  const prefix = safeStart > 0 ? "…" : "";
  const suffix = safeEnd < text.length ? "…" : "";
  return `${prefix}${text.slice(safeStart, safeEnd)}${suffix}`;
}

export class OcrRepository {
  // Search ASTs can produce many SQL shapes. Keep the prepared-statement cache bounded.
  private readonly preparedStatements = new Map<string, ReturnType<DatabaseSync["prepare"]>>();

  constructor(
    private readonly db: DatabaseSync | undefined,
    private readonly unavailableReason = "OCR database is unavailable",
  ) {}

  private statement(sql: string): ReturnType<DatabaseSync["prepare"]> {
    const db = this.database();
    let statement = this.preparedStatements.get(sql);
    if (statement) {
      // アクセス順を更新し、FIFO ではなく LRU で追い出す。
      this.preparedStatements.delete(sql);
      this.preparedStatements.set(sql, statement);
      return statement;
    }

    if (this.preparedStatements.size >= MAX_PREPARED_STATEMENTS) {
      const leastRecentlyUsedSql = this.preparedStatements.keys().next().value;
      if (leastRecentlyUsedSql !== undefined) this.preparedStatements.delete(leastRecentlyUsedSql);
    }
    statement = db.prepare(sql);
    this.preparedStatements.set(sql, statement);
    return statement;
  }

  private database(): DatabaseSync {
    // 原因 (ローカルパスを含みうる) は cause に残してログ専用にし、メッセージは固定文言にする。
    if (!this.db) throw new ClientSafeError("OCR database is unavailable", { cause: new Error(this.unavailableReason) });
    return this.db;
  }

  search(options: SearchOptions): { results: OcrHit[]; returned: number; offset: number; limit: number; nextAfterId: number | null } {
    let queryNode: QueryNode;
    try {
      queryNode = parseSearchQuery(options.query);
    } catch (error) {
      throw new ClientSafeError(error instanceof Error ? error.message : "Invalid search query.", { cause: error });
    }
    if (options.afterId !== undefined && options.offset !== 0) {
      throw new ClientSafeError("Use afterId or offset for search pagination, not both.");
    }

    const compiled = compileQuery(queryNode);
    const positiveTerms = [...new Set(extractPositiveTerms(queryNode))];
    const clauses = [compiled.sql];
    const params: Array<string | number> = [...compiled.params];

    if (options.label !== undefined) {
      clauses.push("si.file_path = ?");
      params.push(options.label);
    }
    if (options.reviewed !== undefined) {
      clauses.push(reviewedSqlPredicate("si.reviewed", options.reviewed));
    }
    if (options.afterId !== undefined) {
      clauses.push("si.id > ?");
      params.push(options.afterId);
    }

    // Query expressions are evaluated against the source table so arbitrary nested boolean
    // combinations retain stable ID ordering and share the same label/review/cursor filters.
    params.push(options.limit + 1);
    const offsetClause = options.afterId === undefined ? "OFFSET ?" : "";
    if (options.afterId === undefined) params.push(options.offset);

    const rows = this.statement(`
      SELECT si.id, si.file_path, si.file_name, si.reviewed, si.ocr_text
      FROM source_images AS si
      WHERE ${clauses.join(" AND ")}
      ORDER BY si.id ASC
      LIMIT ? ${offsetClause}
    `).all(...params) as Array<{
      id: number; file_path: string | null; file_name: string | null;
      reviewed: number | null; ocr_text: string | null;
    }>;

    const hasMore = rows.length > options.limit;
    const pageRows = hasMore ? rows.slice(0, options.limit) : rows;
    const results = pageRows.map((row) => ({
      id: row.id,
      file_path: row.file_path,
      file_name: row.file_name,
      reviewed: row.reviewed,
      snippet: makeSnippet(row.ocr_text, positiveTerms, options.snippetLength),
    }));
    const nextAfterId = hasMore && results.length > 0 ? results[results.length - 1]!.id : null;
    return { results, returned: results.length, offset: options.offset, limit: options.limit, nextAfterId };
  }

  getById(id: number, maxTextLength: number): (OcrHit & { ocr_text: string; truncated: boolean }) | null {
    const row = this.statement(OCR_SQL.getById).get(id) as {
      id: number; file_path: string | null; file_name: string | null;
      reviewed: number | null; ocr_text: string | null;
    } | undefined;
    if (!row) return null;
    const fullText = row.ocr_text ?? "";
    const truncated = fullText.length > maxTextLength;
    const outputText = safeSlice(fullText, 0, maxTextLength);
    return {
      id: row.id,
      file_path: row.file_path,
      file_name: row.file_name,
      reviewed: row.reviewed,
      snippet: safeSlice(fullText, 0, Math.min(160, outputText.length)),
      ocr_text: outputText,
      truncated
    };
  }

  listLabels(limit = 100): Array<{ label: string; count: number }> {
    return this.statement(OCR_SQL.listLabels).all(limit) as Array<{ label: string; count: number }>;
  }

  getStats(): {
    total: number;
    reviewed: number;
    unreviewed: number;
    labels: number;
  } {
    // Combine all statistics into one aggregate so source_images only needs one table-level pass.
    // COUNT(DISTINCT ...) still performs duplicate-elimination work, but avoids a separate SELECT/scan.
    const row = this.statement(OCR_SQL.getStats).get() as {
      total: number; reviewed: number; unreviewed: number; labels: number;
    };
    // node:sqlite returns rows with a null prototype; expose a plain object as before.
    return { ...row };
  }
}

import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { reviewedSqlPredicate } from "../ocr/reviewed.mjs";

if (!parentPort) throw new Error("Japanese search worker requires a parent port");

let db;
let metadata;

const SEARCHABLE_TOKEN = /[\p{L}\p{N}]/u;
function searchableTokens(value) {
  return String(value ?? "")
    .split(/\s+/u)
    .filter((token) => token.length > 0 && SEARCHABLE_TOKEN.test(token));
}

function quoteFts5Token(token) {
  return `"${token.replace(/"/gu, '""')}"`;
}

function buildMatchExpression(tokens, mode) {
  return tokens.map(quoteFts5Token).join(mode === "all" ? " AND " : " OR ");
}

// FTS5 stores pre-tokenized terms using its built-in unicode61 tokenizer. Build the
// displayed snippet from the original OCR text rather than token text from the index.
function asciiFold(value) {
  return value.replace(/[A-Z]/gu, (char) => String.fromCharCode(char.charCodeAt(0) + 32));
}

function makeSnippet(value, queryTokens) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  if (!text) return "";

  const foldedText = asciiFold(text);
  const highlightTokens = [...new Set(queryTokens.map(asciiFold))]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .slice(0, 16);
  let firstMatch = -1;
  for (const token of highlightTokens) {
    const at = foldedText.indexOf(token);
    if (at >= 0 && (firstMatch < 0 || at < firstMatch)) firstMatch = at;
  }

  const maxChars = 180;
  if (firstMatch < 0) {
    let end = Math.min(text.length, maxChars);
    if (end > 0 && end < text.length) {
      const previous = text.charCodeAt(end - 1);
      const next = text.charCodeAt(end);
      if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
    }
    return text.length > end ? `${text.slice(0, end)}…` : text;
  }
  let start = Math.max(0, firstMatch - 60);
  if (start + maxChars > text.length) start = Math.max(0, text.length - maxChars);
  let end = Math.min(text.length, start + maxChars);
  // Avoid cutting a UTF-16 surrogate pair at either edge.
  if (start > 0 && start < text.length) {
    const unit = text.charCodeAt(start);
    if (unit >= 0xdc00 && unit <= 0xdfff) start += 1;
  }
  if (end > start && end < text.length) {
    const unit = text.charCodeAt(end - 1);
    if (unit >= 0xd800 && unit <= 0xdbff) end -= 1;
  }

  const foldedSlice = foldedText.slice(start, end);
  const ranges = [];
  for (const token of highlightTokens) {
    let from = 0;
    while (from < foldedSlice.length) {
      const at = foldedSlice.indexOf(token, from);
      if (at < 0) break;
      ranges.push([at, at + token.length]);
      from = at + Math.max(1, token.length);
    }
  }
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged = [];
  for (const [rangeStart, rangeEnd] of ranges) {
    const last = merged[merged.length - 1];
    if (last && rangeStart < last[1]) last[1] = Math.max(last[1], rangeEnd);
    else merged.push([rangeStart, rangeEnd]);
  }

  let result = start > 0 ? "…" : "";
  let cursor = 0;
  for (const [rangeStart, rangeEnd] of merged) {
    result += text.slice(start + cursor, start + rangeStart);
    result += `〔${text.slice(start + rangeStart, start + rangeEnd)}〕`;
    cursor = rangeEnd;
  }
  result += text.slice(start + cursor, end);
  if (end < text.length) result += "…";
  return result;
}

function openIndex() {
  db = new DatabaseSync(workerData.indexPath, {
    readOnly: true,
    timeout: workerData.busyTimeoutMs,
    allowExtension: true,
  });
  try {
    db.loadExtension(workerData.extensionPath, "sqlite3_vaporetto_init");
    db.enableLoadExtension(false);

    const tableRows = db.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('japanese_documents', 'japanese_fts', 'japanese_search_meta')",
    ).all();
    const byName = new Map(tableRows.map((row) => [row.name, row.sql ?? ""]));
    if (!byName.has("japanese_documents") || !byName.has("japanese_fts") || !byName.has("japanese_search_meta")) {
      throw new Error("Japanese search index is missing required tables");
    }
    const ftsSql = byName.get("japanese_fts");
    if (!/\bUSING\s+fts5\b/i.test(ftsSql)) {
      throw new Error("japanese_fts is not an FTS5 virtual table");
    }
    if (!/\bcontent\s*=\s*(['"])\1/i.test(ftsSql) || !/\btokenize\s*=\s*(['"])unicode61\1/i.test(ftsSql)) {
      throw new Error("japanese_fts must be a contentless FTS5 table using the unicode61 tokenizer; rebuild it with npm run japanese-search:index");
    }

    metadata = db.prepare(
      "SELECT schema_version, tokenizer, indexed_at, source_record_count, source_max_id FROM japanese_search_meta WHERE singleton = 1",
    ).get();
    if (!metadata || metadata.schema_version !== 2 || metadata.tokenizer !== "vaporetto-pretokenized-unicode61") {
      throw new Error("Japanese search index metadata is missing or incompatible; rebuild it with npm run japanese-search:index");
    }

    // Only the query-side Vaporetto helper loads the language model. The indexed FTS5
    // table uses unicode61 over pre-tokenized terms, avoiding a second Predictor load.
    const probe = db.prepare("SELECT vaporetto_split('検索', ' ') AS tokens").get();
    const probeTokens = searchableTokens(probe?.tokens);
    if (probeTokens.length === 0) throw new Error("Vaporetto query tokenizer returned no searchable tokens");

    db.prepare("SELECT rowid FROM japanese_fts WHERE japanese_fts MATCH ? LIMIT 1").get(quoteFts5Token(probeTokens[0]));
  } catch (error) {
    try { db.close(); } catch { /* Preserve the validation failure. */ }
    throw error;
  }
}

function search(message) {
  parentPort.postMessage({ type: "started", id: message.id });
  const query = message.query.trim();
  const tokenText = db.prepare("SELECT vaporetto_split(?, ' ') AS tokens").get(query)?.tokens ?? "";
  const queryTokens = searchableTokens(tokenText);
  if (queryTokens.length === 0) {
    parentPort.postMessage({ type: "result", id: message.id, ok: false, code: "no_searchable_tokens" });
    return;
  }
  const matchExpression = buildMatchExpression(queryTokens, message.mode);

  const clauses = ["japanese_fts MATCH ?"];
  const params = [matchExpression];
  if (message.label !== undefined) {
    clauses.push("d.file_path = ?");
    params.push(message.label);
  }
  if (message.reviewed !== undefined) {
    clauses.push(reviewedSqlPredicate("d.reviewed", message.reviewed));
  }
  params.push(message.limit + 1, message.offset);

  const rows = db.prepare(`
    SELECT d.source_id AS id,
           d.file_path AS label,
           d.file_name AS fileName,
           d.reviewed AS reviewed,
           d.ocr_text AS ocrText,
           bm25(japanese_fts) AS score
    FROM japanese_fts
    JOIN japanese_documents AS d ON d.source_id = japanese_fts.rowid
    WHERE ${clauses.join(" AND ")}
    ORDER BY score ASC, d.source_id ASC
    LIMIT ? OFFSET ?
  `).all(...params);

  const hasMore = rows.length > message.limit;
  const page = hasMore ? rows.slice(0, message.limit) : rows;
  parentPort.postMessage({
    type: "result",
    id: message.id,
    ok: true,
    value: {
      query,
      mode: message.mode,
      queryTokens,
      returned: page.length,
      limit: message.limit,
      offset: message.offset,
      nextOffset: hasMore ? message.offset + page.length : null,
      index: {
        tokenizer: metadata.tokenizer,
        indexedAt: metadata.indexed_at,
        indexedRecords: metadata.source_record_count,
        sourceMaxId: metadata.source_max_id,
      },
      results: page.map((row) => ({
        id: row.id,
        label: row.label,
        fileName: row.fileName,
        reviewed: row.reviewed ?? null,
        score: Number(Number(row.score).toPrecision(6)),
        snippet: makeSnippet(row.ocrText, queryTokens),
      })),
    },
  });
}

try {
  openIndex();
  parentPort.postMessage({ type: "ready", metadata });
} catch (error) {
  parentPort.postMessage({
    type: "startup-error",
    message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
  parentPort.close();
}

parentPort.on("message", (message) => {
  if (!message || message.type !== "search") return;
  try {
    search(message);
  } catch (error) {
    parentPort.postMessage({
      type: "result",
      id: message.id,
      ok: false,
      code: "search_failed",
      operatorMessage: error instanceof Error ? error.message : String(error),
    });
  }
});

parentPort.on("close", () => {
  try { db?.close(); } catch { /* Worker is shutting down. */ }
});

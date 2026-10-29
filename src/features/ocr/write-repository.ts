import { DatabaseSync } from "node:sqlite";
import { accessSync, constants } from "node:fs";
import { ClientSafeError, describeForLog } from "../../shared/errors.js";
import { validateOcrSchema } from "./sqlite.js";

export const MAX_OCR_TEXT_CODE_UNITS = 20_000;
export const MAX_OCR_TEXT_BYTES = 64 * 1024;
export const OCR_HISTORY_WARNING_BYTES = 10 * 1024 * 1024;
export const OCR_WRITE_BUSY_TIMEOUT_MS = 500;

export type OcrWriteErrorCode =
  | "invalid_input"
  | "record_not_found"
  | "reviewed_record_protected"
  | "database_busy"
  | "write_failed"
  | "write_unavailable";

export class OcrWriteError extends ClientSafeError {
  constructor(readonly code: OcrWriteErrorCode, message: string) {
    super(message);
    this.name = "OcrWriteError";
  }
}

export interface OcrWriteSuccess {
  id: number;
  changed: boolean;
  reviewed: 0;
  historyId?: number;
  changedAt?: string;
}

const HISTORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS mcp_ocr_edit_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_image_id INTEGER NOT NULL,
  changed_at TEXT NOT NULL,
  old_text TEXT NOT NULL,
  new_text TEXT NOT NULL,
  old_bytes INTEGER NOT NULL DEFAULT 0 CHECK (old_bytes >= 0),
  new_bytes INTEGER NOT NULL DEFAULT 0 CHECK (new_bytes >= 0)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_mcp_ocr_edit_history_source_image_id
  ON mcp_ocr_edit_history(source_image_id, id);
`;

export interface OcrWriteRepositoryOptions {
  log?: (...args: unknown[]) => void;
  busyTimeoutMs?: number;
}

/** Separate writable handle; the main OCR repository remains read-only. */
export class OcrWriteRepository {
  private readonly statements = new Map<string, ReturnType<DatabaseSync["prepare"]>>();
  private historyRows: number;
  private historyTextBytes: number;
  private warnedHistoryThreshold: boolean;
  private readonly log: (...args: unknown[]) => void;

  constructor(private readonly db: DatabaseSync, options: OcrWriteRepositoryOptions = {}) {
    this.log = options.log ?? console.log;
    try {
      validateOcrSchema(db);
      const historyTableExisted = Boolean(db.prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'mcp_ocr_edit_history'"
      ).get());
      db.exec(HISTORY_SCHEMA);
      if (historyTableExisted) {
        // Upgrade pre-optimization history tables in one transaction. If adding a column or
        // backfilling fails, roll the entire migration back so the next startup can retry it.
        const initialColumns = new Set((db.prepare("PRAGMA table_info(mcp_ocr_edit_history)").all() as Array<{ name: string }>).map((row) => row.name));
        if (!initialColumns.has("old_bytes") || !initialColumns.has("new_bytes")) {
          db.exec("BEGIN IMMEDIATE");
          try {
            // Re-check after acquiring the write lock in case another server instance migrated it first.
            const columns = new Set((db.prepare("PRAGMA table_info(mcp_ocr_edit_history)").all() as Array<{ name: string }>).map((row) => row.name));
            let needsBackfill = false;
            if (!columns.has("old_bytes")) {
              db.exec("ALTER TABLE mcp_ocr_edit_history ADD COLUMN old_bytes INTEGER NOT NULL DEFAULT 0 CHECK (old_bytes >= 0)");
              needsBackfill = true;
            }
            if (!columns.has("new_bytes")) {
              db.exec("ALTER TABLE mcp_ocr_edit_history ADD COLUMN new_bytes INTEGER NOT NULL DEFAULT 0 CHECK (new_bytes >= 0)");
              needsBackfill = true;
            }
            if (needsBackfill) {
              db.exec(`UPDATE mcp_ocr_edit_history
                SET old_bytes = length(CAST(old_text AS BLOB)),
                    new_bytes = length(CAST(new_text AS BLOB))`);
            }
            db.exec("COMMIT");
          } catch (error) {
            try { db.exec("ROLLBACK"); } catch { /* preserve migration failure */ }
            throw error;
          }
        }
      }
      // With automatic deletion disabled, MAX(id) estimates the row count. SUM only reads compact
      // integer byte columns; it no longer recalculates lengths from every historical OCR text.
      const totals = db.prepare(`
        SELECT COALESCE(MAX(id), 0) AS rows,
               COALESCE(SUM(old_bytes + new_bytes), 0) AS text_bytes
        FROM mcp_ocr_edit_history
      `).get() as { rows: number; text_bytes: number };
      this.historyRows = Number(totals.rows);
      this.historyTextBytes = Number(totals.text_bytes);
      this.warnedHistoryThreshold = this.historyTextBytes >= OCR_HISTORY_WARNING_BYTES;
      if (this.warnedHistoryThreshold) this.logHistoryThresholdWarning();
    } catch (error) {
      try { db.close(); } catch { /* preserve initialization failure */ }
      throw error;
    }
  }

  static open(path: string, options: OcrWriteRepositoryOptions = {}): OcrWriteRepository {
    accessSync(path, constants.R_OK | constants.W_OK);
    const db = new DatabaseSync(path, { timeout: options.busyTimeoutMs ?? OCR_WRITE_BUSY_TIMEOUT_MS });
    return new OcrWriteRepository(db, options);
  }

  close(): void {
    this.statements.clear();
    this.db.close();
  }

  getHistoryEstimate(): { rows: number; textBytes: number } {
    return { rows: this.historyRows, textBytes: this.historyTextBytes };
  }

  private statement(sql: string): ReturnType<DatabaseSync["prepare"]> {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  private logHistoryThresholdWarning(): void {
    this.log(
      `[ocr/write] history warning: mcp_ocr_edit_history rowCountEstimate=${this.historyRows} (MAX(id), under the no-deletion policy), estimatedTextBytes=${this.historyTextBytes} UTF-8 bytes for old_text + new_text (threshold: ${OCR_HISTORY_WARNING_BYTES} bytes / 10 MiB); no records were deleted`
    );
  }

  private checkHistoryThreshold(previousBytes: number): void {
    if (!this.warnedHistoryThreshold && previousBytes < OCR_HISTORY_WARNING_BYTES && this.historyTextBytes >= OCR_HISTORY_WARNING_BYTES) {
      this.warnedHistoryThreshold = true;
      this.logHistoryThresholdWarning();
    }
  }

  writeText(id: number, newText: string): OcrWriteSuccess {
    if (!Number.isSafeInteger(id) || id <= 0 || typeof newText !== "string") {
      throw new OcrWriteError("invalid_input", "A positive integer id and string newText are required.");
    }
    if (newText.length > MAX_OCR_TEXT_CODE_UNITS || Buffer.byteLength(newText, "utf8") > MAX_OCR_TEXT_BYTES) {
      throw new OcrWriteError(
        "invalid_input",
        `newText exceeds the limit of ${MAX_OCR_TEXT_CODE_UNITS} UTF-16 code units and ${MAX_OCR_TEXT_BYTES} UTF-8 bytes.`
      );
    }

    let began = false;
    let previousHistoryBytes = this.historyTextBytes;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      began = true;
      const row = this.statement("SELECT id, ocr_text, reviewed FROM source_images WHERE id = ?").get(id) as
        { id: number; ocr_text: string | null; reviewed: number } | undefined;
      if (!row) throw new OcrWriteError("record_not_found", "No OCR record exists with this id.");
      // Treat every non-zero value as protected; this fails closed even if the DB contains an unexpected flag.
      if (row.reviewed !== 0) {
        throw new OcrWriteError("reviewed_record_protected", "This OCR record is reviewed and cannot be changed by the MCP write tool.");
      }

      const oldText = row.ocr_text ?? "";
      if (oldText.length > MAX_OCR_TEXT_CODE_UNITS || Buffer.byteLength(oldText, "utf8") > MAX_OCR_TEXT_BYTES) {
        throw new OcrWriteError(
          "invalid_input",
          `The stored OCR text exceeds the write limit (${MAX_OCR_TEXT_CODE_UNITS} UTF-16 code units / ${MAX_OCR_TEXT_BYTES} UTF-8 bytes); it was left unchanged.`
        );
      }
      if (oldText === newText) {
        this.db.exec("COMMIT");
        began = false;
        return { id, changed: false, reviewed: 0 };
      }

      // Defense in depth: repeat reviewed=0 in the UPDATE predicate as well as the earlier guard.
      // BEGIN IMMEDIATE serializes SQLite writers while this short transaction is active.
      const update = this.statement("UPDATE source_images SET ocr_text = ? WHERE id = ? AND reviewed = 0").run(newText, id);
      const updated = Number(update.changes);
      if (updated !== 1) {
        const current = this.statement("SELECT reviewed FROM source_images WHERE id = ?").get(id) as { reviewed: number } | undefined;
        if (!current) throw new OcrWriteError("record_not_found", "No OCR record exists with this id.");
        throw new OcrWriteError("reviewed_record_protected", "This OCR record is reviewed and cannot be changed by the MCP write tool.");
      }

      const changedAt = new Date().toISOString();
      const oldBytes = Buffer.byteLength(oldText, "utf8");
      const newBytes = Buffer.byteLength(newText, "utf8");
      const history = this.statement(`
        INSERT INTO mcp_ocr_edit_history (source_image_id, changed_at, old_text, new_text, old_bytes, new_bytes)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, changedAt, oldText, newText, oldBytes, newBytes);
      const historyId = Number(history.lastInsertRowid);
      this.db.exec("COMMIT");
      began = false;

      previousHistoryBytes = this.historyTextBytes;
      this.historyRows += 1;
      this.historyTextBytes += oldBytes + newBytes;
      this.checkHistoryThreshold(previousHistoryBytes);
      return { id, changed: true, reviewed: 0, historyId, changedAt };
    } catch (error) {
      if (began) {
        try { this.db.exec("ROLLBACK"); } catch (rollbackError) {
          this.log("[ocr/write] rollback failed after OCR write error:", describeForLog(rollbackError));
        }
      }
      if (error instanceof OcrWriteError) throw error;
      if (error instanceof Error && /SQLITE_BUSY|database is locked|database is busy/i.test(`${error.name} ${error.message}`)) {
        throw new OcrWriteError("database_busy", "The OCR database is busy; retry the write shortly.");
      }
      throw error;
    }
  }
}

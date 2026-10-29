import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { KNOWN_SCOPES, SCOPE_READ, parseScopes } from "./scopes.js";
import { describeForLog } from "../shared/errors.js";

// 名前付き静的トークンのストア。OAuth DB とは別ファイルで管理する
// (OAuth DB は消しても再同意で復旧できるが、配布済みの静的トークンは消えると困るため)。
//
//   purpose = "api"   : MCP リクエストの Authorization: Bearer に使う (Claude Code / Cursor / curl 等)
//   purpose = "login" : OAuth 同意画面で本人確認に使う。MCP には使えない
//
// トークン本体は保存せず SHA-256 ハッシュのみ保存する (256 bit ランダム値なので高速ハッシュで十分)。

export type TokenPurpose = "api" | "login";

export const TOKEN_PREFIX: Readonly<Record<TokenPurpose, string>> = {
  api: "ocrmcp_api_",
  login: "ocrmcp_login_",
};

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LAST_USED_THROTTLE_SECONDS = 60;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS static_tokens (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('api', 'login')),
  token_hash TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  last_used_at INTEGER
) STRICT;
-- 名前は有効なトークンの間でのみ一意。失効済みの名前は再利用できる (ローテーション用)。
CREATE UNIQUE INDEX IF NOT EXISTS idx_static_tokens_active_name ON static_tokens(name) WHERE revoked_at IS NULL;
`;

const SQLITE_BUSY_TIMEOUT_MS = 500;
const now = () => Math.floor(Date.now() / 1000);
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

export interface StaticTokenRecord {
  name: string;
  purpose: TokenPurpose;
  scopes: string[];
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  lastUsedAt: number | null;
  status: "active" | "expired" | "revoked";
}

export interface VerifiedToken {
  name: string;
  purpose: TokenPurpose;
  scopes: string[];
  expiresAt: number | null;
}

type Row = {
  name: string; purpose: TokenPurpose; scope: string; created_at: number;
  expires_at: number | null; revoked_at: number | null; last_used_at: number | null;
};

function toRecord(row: Row, t: number): StaticTokenRecord {
  return {
    name: row.name,
    purpose: row.purpose,
    scopes: parseScopes(row.scope),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
    status: row.revoked_at !== null ? "revoked" : row.expires_at !== null && row.expires_at <= t ? "expired" : "active",
  };
}

export class TokenStore {
  readonly db: DatabaseSync;
  private readonly preparedStatements = new Map<string, ReturnType<DatabaseSync["prepare"]>>();
  private nextLastUsedAttemptAt = 0;

  private statement(sql: string): ReturnType<DatabaseSync["prepare"]> {
    let statement = this.preparedStatements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.preparedStatements.set(sql, statement);
    }
    return statement;
  }

  constructor(databasePath: string) {
    const absolutePath = resolve(databasePath);
    mkdirSync(dirname(absolutePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(absolutePath, { timeout: SQLITE_BUSY_TIMEOUT_MS });
    try {
      this.db.exec(SCHEMA);
      chmodSync(absolutePath, 0o600);
    } catch (error) {
      try { this.db.close(); } catch { /* Preserve the initialization error. */ }
      throw error;
    }
  }

  close(): void { this.db.close(); }

  /**
   * トークンを発行する。戻り値の `token` はここでしか取得できない。
   * api トークンは常に ocr:read を含み、追加スコープは明示した場合のみ付与される。
   * login トークンはスコープを持たない。
   */
  create(input: { name: string; purpose: TokenPurpose; scopes?: string[]; expiresInDays?: number }): { token: string; record: StaticTokenRecord } {
    if (!NAME_RE.test(input.name)) throw new Error("Invalid token name (use letters, digits, '.', '_' or '-', up to 64 chars)");
    let scopes: string[] = [];
    if (input.purpose === "api") {
      scopes = [...new Set([SCOPE_READ, ...(input.scopes ?? [])])];
      const unknown = scopes.filter((s) => !KNOWN_SCOPES.has(s));
      if (unknown.length > 0) throw new Error(`Unknown scope: ${unknown.join(", ")}`);
    } else if ((input.scopes ?? []).length > 0) {
      throw new Error("login tokens cannot have scopes");
    }
    if (input.expiresInDays !== undefined && (!Number.isFinite(input.expiresInDays) || input.expiresInDays <= 0 || input.expiresInDays > 3650)) {
      throw new Error("Invalid expiry");
    }
    const t = now();
    const expiresAt = input.expiresInDays === undefined ? null : t + Math.round(input.expiresInDays * 86400);
    const token = `${TOKEN_PREFIX[input.purpose]}${randomBytes(32).toString("base64url")}`;
    try {
      this.db.prepare(`INSERT INTO static_tokens (name, purpose, token_hash, scope, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(input.name, input.purpose, digest(token), scopes.join(" "), t, expiresAt);
    } catch (error) {
      if (error instanceof Error && /UNIQUE/i.test(error.message)) {
        throw new Error(`An active token named "${input.name}" already exists (revoke it first to rotate)`);
      }
      throw error;
    }
    return {
      token,
      record: { name: input.name, purpose: input.purpose, scopes, createdAt: t, expiresAt, revokedAt: null, lastUsedAt: null, status: "active" },
    };
  }

  /** 有効 (未失効・未期限切れ) で、かつ期待する用途のトークンなら情報を返す。 */
  verify(candidate: string, purpose: TokenPurpose): VerifiedToken | undefined {
    if (!candidate.startsWith(TOKEN_PREFIX[purpose]) || candidate.length > 256) return undefined;
    const t = now();
    const row = this.statement(`SELECT id, name, purpose, scope, expires_at, last_used_at FROM static_tokens
      WHERE token_hash = ? AND purpose = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`)
      .get(digest(candidate), purpose, t) as {
        id: number; name: string; purpose: TokenPurpose; scope: string;
        expires_at: number | null; last_used_at: number | null;
      } | undefined;
    if (!row) return undefined;

    // last_used_at is telemetry, not part of token validity. Avoid a write in the throttle window;
    // keep the SQL predicate as a second guard if another process updates it after this SELECT.
    // A failed telemetry write must not turn an otherwise valid token into an authentication failure.
    const lastUsedIsStale = row.last_used_at === null || row.last_used_at <= t - LAST_USED_THROTTLE_SECONDS;
    if (lastUsedIsStale && t >= this.nextLastUsedAttemptAt) {
      try {
        this.statement(`UPDATE static_tokens SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at <= ?)`)
          .run(t, row.id, t - LAST_USED_THROTTLE_SECONDS);
      } catch (error) {
        // A failed telemetry write can wait for SQLite's busy_timeout and block this synchronous
        // server. Back off globally for this connection so every subsequent request does not repeat
        // that wait. last_used_at is telemetry only; token validity is decided by the SELECT above.
        this.nextLastUsedAttemptAt = t + LAST_USED_THROTTLE_SECONDS;
        console.error("[auth] failed to update static token last_used_at; retry is deferred for 60 seconds and token verification remains successful:", describeForLog(error));
      }
    }
    return { name: row.name, purpose: row.purpose, scopes: parseScopes(row.scope), expiresAt: row.expires_at };
  }

  list(): StaticTokenRecord[] {
    const t = now();
    const rows = this.db.prepare(`SELECT name, purpose, scope, created_at, expires_at, revoked_at, last_used_at
      FROM static_tokens ORDER BY created_at DESC, id DESC`).all() as Row[];
    return rows.map((row) => toRecord(row, t));
  }

  /** 名前で有効なトークンを失効させる。失効させたら true。 */
  revoke(name: string): boolean {
    const result = this.db.prepare("UPDATE static_tokens SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL").run(now(), name);
    return Number(result.changes) > 0;
  }
}

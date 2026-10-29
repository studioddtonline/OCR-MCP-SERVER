import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** WHATWG URL の hostname 表記 (IPv6 は角括弧付き)。 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * トークンエンドポイントで OAuth の `invalid_grant` として扱う「入力の誤り」
 * (不明・使用済み・期限切れの認可コード / リフレッシュトークン、PKCE 不一致など)。
 * DB 障害などの想定外の例外とは型で区別し、後者は HTTP 層で 503 にする。
 */
export class OAuthGrantError extends Error {
  constructor() {
    super("invalid_grant");
    this.name = "OAuthGrantError";
  }
}

/** クライアント登録・認可リクエストの入力検証エラー (DB 障害ではない)。HTTP 層で対応する OAuth エラーコードに変換する。 */
export class OAuthValidationError extends Error {
  constructor(
    message: string,
    readonly oauthError: "invalid_client_metadata" | "invalid_redirect_uri" | "invalid_request",
  ) {
    super(message);
    this.name = "OAuthValidationError";
  }
}

export type OAuthClient = {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: "none";
};

export type StoredAccessToken = {
  clientId: string;
  scope: string;
  resource: string;
  expiresAt: number;
};

const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  redirect_uris_json TEXT NOT NULL,
  grant_types_json TEXT NOT NULL CHECK (grant_types_json = '["authorization_code","refresh_token"]'),
  response_types_json TEXT NOT NULL CHECK (response_types_json = '["code"]'),
  token_endpoint_auth_method TEXT NOT NULL CHECK (token_endpoint_auth_method = 'none'),
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL CHECK (code_challenge_method = 'S256'),
  scope TEXT NOT NULL,
  resource TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS idx_oauth_codes_expiry ON oauth_authorization_codes(expires_at);
CREATE TABLE IF NOT EXISTS oauth_access_tokens (
  token_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  family_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  resource TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS idx_oauth_access_expiry ON oauth_access_tokens(expires_at);
CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  family_id TEXT NOT NULL,
  parent_token_hash TEXT,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  resource TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  revoked_at INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_family ON oauth_refresh_tokens(family_id);
CREATE TABLE IF NOT EXISTS oauth_grants (
  id INTEGER PRIMARY KEY,
  subject TEXT NOT NULL,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  resource TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  UNIQUE(subject, client_id, resource)
) STRICT;
-- 認可ごとに毎回ログイン (トークン入力) する方式に変更したため、ログインセッションは廃止。
-- 旧バージョンの DB に残っているテーブルは削除する。
DROP TABLE IF EXISTS oauth_login_sessions;
`;

const SQLITE_BUSY_TIMEOUT_MS = 500;
const now = () => Math.floor(Date.now() / 1000);
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const opaque = (bytes = 32) => randomBytes(bytes).toString("base64url");

function equalHex(a: string, b: string): boolean {
  const aa = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

export class OAuthStore {
  readonly db: DatabaseSync;
  private readonly preparedStatements = new Map<string, ReturnType<DatabaseSync["prepare"]>>();

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

  private validateClientInput(input: { clientName: string; redirectUris: string[] }): { name: string; uris: string[] } {
    const name = input.clientName.trim();
    if (!name || name.length > 200) throw new OAuthValidationError("Invalid client_name", "invalid_client_metadata");
    if (input.redirectUris.length < 1 || input.redirectUris.length > 20) throw new OAuthValidationError("Invalid redirect_uris", "invalid_redirect_uri");
    for (const raw of input.redirectUris) {
      let u: URL;
      try { u = new URL(raw); } catch { throw new OAuthValidationError("Invalid redirect URI", "invalid_redirect_uri"); }
      // 許可するのは「HTTPS」または「HTTP かつループバックホスト」だけ。
      // (以前は「HTTPS でない かつ ループバックでない」場合だけ拒否していたため、ftp://localhost/... のように
      //  ループバックホストでさえあれば任意のスキームが通ってしまっていた。)
      const isHttps = u.protocol === "https:";
      const isLoopbackHttp = u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname);
      if (!isHttps && !isLoopbackHttp) {
        throw new OAuthValidationError("Redirect URI must use HTTPS, or HTTP on a loopback host", "invalid_redirect_uri");
      }
      // URL.username/password/hash は空の区切りを表現しないことがある (例: https://@host/cb、https://host/cb#)。
      // パーサーで正規化される前の URI からも authority の userinfo 区切りと fragment 区切りを検出する。
      const authority = raw.trimStart().match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/)?.[1];
      const hasUserInfoDelimiter = authority?.includes("@") ?? false;
      const hasFragmentDelimiter = raw.includes("#");
      if (u.username || u.password || u.hash || hasUserInfoDelimiter || hasFragmentDelimiter) {
        throw new OAuthValidationError("Redirect URI must not contain credentials or fragment", "invalid_redirect_uri");
      }
    }
    return { name, uris: [...new Set(input.redirectUris)] };
  }

  registerClient(input: { clientName: string; redirectUris: string[] }): OAuthClient {
    const { name, uris } = this.validateClientInput(input);
    const clientId = opaque(24);
    this.db.prepare(`INSERT INTO oauth_clients
      (client_id, client_name, redirect_uris_json, grant_types_json, response_types_json, token_endpoint_auth_method, created_at)
      VALUES (?, ?, ?, '["authorization_code","refresh_token"]', '["code"]', 'none', ?)`)
      .run(clientId, name, JSON.stringify(uris), now());
    return { clientId, clientName: name, redirectUris: uris, tokenEndpointAuthMethod: "none" };
  }

  /** CIMD 用: client_id (HTTPS URL) をそのまま主キーにして登録/更新する。 */
  upsertClient(input: { clientId: string; clientName: string; redirectUris: string[] }): OAuthClient {
    const { name, uris } = this.validateClientInput(input);
    this.db.prepare(`INSERT INTO oauth_clients
      (client_id, client_name, redirect_uris_json, grant_types_json, response_types_json, token_endpoint_auth_method, created_at)
      VALUES (?, ?, ?, '["authorization_code","refresh_token"]', '["code"]', 'none', ?)
      ON CONFLICT(client_id) DO UPDATE SET client_name = excluded.client_name, redirect_uris_json = excluded.redirect_uris_json`)
      .run(input.clientId, name, JSON.stringify(uris), now());
    return { clientId: input.clientId, clientName: name, redirectUris: uris, tokenEndpointAuthMethod: "none" };
  }

  getClient(clientId: string): OAuthClient | undefined {
    const row = this.db.prepare("SELECT client_id, client_name, redirect_uris_json FROM oauth_clients WHERE client_id = ?")
      .get(clientId) as { client_id: string; client_name: string; redirect_uris_json: string } | undefined;
    if (!row) return undefined;
    return { clientId: row.client_id, clientName: row.client_name, redirectUris: JSON.parse(row.redirect_uris_json) as string[], tokenEndpointAuthMethod: "none" };
  }

  createAuthorizationCode(input: { clientId: string; redirectUri: string; codeChallenge: string; scope: string; resource: string; ttlSeconds?: number }): string {
    const client = this.getClient(input.clientId);
    if (!client || !client.redirectUris.includes(input.redirectUri)) throw new OAuthValidationError("Unknown client or redirect_uri", "invalid_request");
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(input.codeChallenge)) throw new OAuthValidationError("Invalid PKCE code_challenge", "invalid_request");
    const code = opaque(32);
    const issuedAt = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`INSERT INTO oauth_grants (subject, client_id, scope, resource, created_at, revoked_at)
        VALUES ('owner', ?, ?, ?, ?, NULL)
        ON CONFLICT(subject, client_id, resource) DO UPDATE SET scope = excluded.scope, created_at = excluded.created_at, revoked_at = NULL`)
        .run(input.clientId, input.scope, input.resource, issuedAt);
      this.db.prepare(`INSERT INTO oauth_authorization_codes
        (code_hash, client_id, redirect_uri, code_challenge, code_challenge_method, scope, resource, expires_at)
        VALUES (?, ?, ?, ?, 'S256', ?, ?, ?)`)
        .run(digest(code), input.clientId, input.redirectUri, input.codeChallenge, input.scope, input.resource, issuedAt + (input.ttlSeconds ?? 300));
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return code;
  }

  exchangeAuthorizationCode(input: { code: string; clientId: string; redirectUri: string; codeVerifier: string; accessTtlSeconds?: number; refreshTtlSeconds?: number }): { accessToken: string; refreshToken: string; accessTokenExpiresAt: number; scope: string; resource: string } {
    const codeHash = digest(input.code);
    const row = this.db.prepare("SELECT * FROM oauth_authorization_codes WHERE code_hash = ?").get(codeHash) as {
      client_id: string; redirect_uri: string; code_challenge: string; scope: string; resource: string; expires_at: number; consumed_at: number | null;
    } | undefined;
    if (!row || row.consumed_at !== null || row.expires_at <= now() || row.client_id !== input.clientId || row.redirect_uri !== input.redirectUri) throw new OAuthGrantError();
    if (input.codeVerifier.length < 43 || input.codeVerifier.length > 128 || !/^[A-Za-z0-9._~-]+$/.test(input.codeVerifier)) throw new OAuthGrantError();
    const challenge = createHash("sha256").update(input.codeVerifier).digest("base64url");
    if (!equalHex(Buffer.from(challenge).toString("hex"), Buffer.from(row.code_challenge).toString("hex"))) throw new OAuthGrantError();

    const accessToken = opaque();
    const refreshToken = opaque();
    const accessExpiresAt = now() + (input.accessTtlSeconds ?? 3600);
    const refreshExpiresAt = now() + (input.refreshTtlSeconds ?? 60 * 60 * 24 * 30);
    const familyId = opaque(16);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const consumed = this.db.prepare("UPDATE oauth_authorization_codes SET consumed_at = ? WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?")
        .run(now(), codeHash, now());
      if (Number(consumed.changes) !== 1) throw new OAuthGrantError();
      this.db.prepare(`INSERT INTO oauth_access_tokens (token_hash, client_id, family_id, scope, resource, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(digest(accessToken), input.clientId, familyId, row.scope, row.resource, now(), accessExpiresAt);
      this.db.prepare(`INSERT INTO oauth_refresh_tokens (token_hash, family_id, client_id, scope, resource, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(digest(refreshToken), familyId, input.clientId, row.scope, row.resource, now(), refreshExpiresAt);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { accessToken, refreshToken, accessTokenExpiresAt: accessExpiresAt, scope: row.scope, resource: row.resource };
  }

  verifyAccessToken(token: string, expectedResource: string): StoredAccessToken | undefined {
    const row = this.statement(`SELECT t.client_id, t.scope, t.resource, t.expires_at FROM oauth_access_tokens t
      JOIN oauth_grants g ON g.subject = 'owner' AND g.client_id = t.client_id AND g.resource = t.resource AND g.revoked_at IS NULL
      WHERE t.token_hash = ? AND t.revoked_at IS NULL AND t.expires_at > ?`).get(digest(token), now()) as {
      client_id: string; scope: string; resource: string; expires_at: number;
    } | undefined;
    if (!row || row.resource !== expectedResource) return undefined;
    return { clientId: row.client_id, scope: row.scope, resource: row.resource, expiresAt: row.expires_at };
  }

  refreshAccessToken(input: { refreshToken: string; clientId: string; resource: string; accessTtlSeconds?: number; refreshTtlSeconds?: number }): { accessToken: string; refreshToken: string; accessTokenExpiresAt: number; scope: string; resource: string } {
    const oldHash = digest(input.refreshToken);
    const row = this.db.prepare("SELECT * FROM oauth_refresh_tokens WHERE token_hash = ?").get(oldHash) as {
      family_id: string; client_id: string; scope: string; resource: string; expires_at: number; used_at: number | null; revoked_at: number | null;
    } | undefined;
    if (!row || row.client_id !== input.clientId || row.resource !== input.resource || row.expires_at <= now() || row.revoked_at !== null) throw new OAuthGrantError();
    if (row.used_at !== null) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.prepare("UPDATE oauth_refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL").run(now(), row.family_id);
        this.db.prepare("UPDATE oauth_access_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL").run(now(), row.family_id);
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
      throw new OAuthGrantError();
    }
    const activeGrant = this.db.prepare("SELECT 1 AS ok FROM oauth_grants WHERE subject = 'owner' AND client_id = ? AND resource = ? AND revoked_at IS NULL")
      .get(input.clientId, input.resource) as { ok: number } | undefined;
    if (!activeGrant) throw new OAuthGrantError();
    const accessToken = opaque();
    const refreshToken = opaque();
    const issuedAt = now();
    const accessExpiresAt = issuedAt + (input.accessTtlSeconds ?? 3600);
    const refreshExpiresAt = issuedAt + (input.refreshTtlSeconds ?? 60 * 60 * 24 * 30);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const used = this.db.prepare("UPDATE oauth_refresh_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?").run(issuedAt, oldHash, issuedAt);
      if (Number(used.changes) !== 1) throw new OAuthGrantError();
      this.db.prepare("INSERT INTO oauth_access_tokens (token_hash, client_id, family_id, scope, resource, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(digest(accessToken), input.clientId, row.family_id, row.scope, row.resource, issuedAt, accessExpiresAt);
      this.db.prepare("INSERT INTO oauth_refresh_tokens (token_hash, family_id, parent_token_hash, client_id, scope, resource, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(digest(refreshToken), row.family_id, oldHash, input.clientId, row.scope, row.resource, issuedAt, refreshExpiresAt);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { accessToken, refreshToken, accessTokenExpiresAt: accessExpiresAt, scope: row.scope, resource: row.resource };
  }

  revokeAccessToken(token: string): void {
    this.db.prepare("UPDATE oauth_access_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL").run(now(), digest(token));
  }

  revokeRefreshToken(token: string): void {
    const row = this.db.prepare("SELECT family_id FROM oauth_refresh_tokens WHERE token_hash = ?").get(digest(token)) as { family_id: string } | undefined;
    if (!row) return;
    this.db.prepare("UPDATE oauth_refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL").run(now(), row.family_id);
    this.db.prepare("UPDATE oauth_access_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL").run(now(), row.family_id);
  }

  revokeGrant(clientId: string, resource: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE oauth_grants SET revoked_at = ? WHERE subject = 'owner' AND client_id = ? AND resource = ? AND revoked_at IS NULL").run(now(), clientId, resource);
      this.db.prepare("UPDATE oauth_access_tokens SET revoked_at = ? WHERE client_id = ? AND resource = ? AND revoked_at IS NULL").run(now(), clientId, resource);
      this.db.prepare("UPDATE oauth_refresh_tokens SET revoked_at = ? WHERE client_id = ? AND resource = ? AND revoked_at IS NULL").run(now(), clientId, resource);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  cleanupExpired(): { codes: number; accessTokens: number; refreshTokens: number } {
    const t = now();
    const codes = Number(this.db.prepare("DELETE FROM oauth_authorization_codes WHERE expires_at <= ? OR consumed_at IS NOT NULL").run(t).changes);
    const accessTokens = Number(this.db.prepare("DELETE FROM oauth_access_tokens WHERE expires_at <= ? OR revoked_at IS NOT NULL").run(t).changes);
    const refreshTokens = Number(this.db.prepare("DELETE FROM oauth_refresh_tokens WHERE expires_at <= ? OR revoked_at IS NOT NULL").run(t).changes);
    return { codes, accessTokens, refreshTokens };
  }
}

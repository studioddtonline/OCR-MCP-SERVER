import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, rmSync, renameSync, accessSync, constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const configPath = resolve(process.env.MCP_CONFIG_PATH ?? 'config/config.json');
let config;
try {
  config = JSON.parse(readFileSync(configPath, 'utf8'));
} catch (error) {
  console.error(`Could not read config file ${configPath}:`, error instanceof Error ? error.message : error);
  process.exit(1);
}

const sourcePath = config?.database?.path;
const japanese = config?.japaneseSearch;
const indexPath = japanese?.indexPath;
const extensionPath = japanese?.extensionPath;
const busyTimeoutMs = Number.isInteger(japanese?.busyTimeoutMs) ? japanese.busyTimeoutMs : 500;
const SEARCHABLE_TOKEN = /[\p{L}\p{N}]/u;

function searchableTokens(value) {
  return String(value ?? '')
    .split(/\s+/u)
    .filter((token) => token.length > 0 && SEARCHABLE_TOKEN.test(token));
}

function quoteFts5Token(token) {
  return `"${token.replace(/"/gu, '""')}"`;
}

if (japanese?.enabled !== true) {
  console.error('Set japaneseSearch.enabled=true in config/config.json before building the index.');
  process.exit(1);
}
if (![sourcePath, indexPath, extensionPath].every((value) => typeof value === 'string' && value.startsWith('/'))) {
  console.error('database.path, japaneseSearch.indexPath, and japaneseSearch.extensionPath must be absolute paths.');
  process.exit(1);
}
const configuredDatabases = [
  sourcePath,
  indexPath,
  ...(typeof config?.oauth?.databasePath === 'string' ? [config.oauth.databasePath] : []),
  ...(typeof config?.staticTokens?.databasePath === 'string' ? [config.staticTokens.databasePath] : []),
].map((path) => resolve(path));
if (new Set(configuredDatabases).size !== configuredDatabases.length) {
  console.error('The Japanese search index must be different from the OCR, OAuth, and static-token database files.');
  process.exit(1);
}
if (configuredDatabases.includes(resolve(extensionPath))) {
  console.error('The native extension path must not point at any database file.');
  process.exit(1);
}

accessSync(sourcePath, constants.R_OK);
accessSync(extensionPath, constants.R_OK);
mkdirSync(dirname(indexPath), { recursive: true });
const stagingPath = `${indexPath}.building-${process.pid}-${randomUUID()}`;
let source;
let target;
let sourceTransaction = false;
let targetTransaction = false;

function closeQuietly(db) {
  try { db?.close(); } catch { /* Preserve the original failure. */ }
}

try {
  source = new DatabaseSync(sourcePath, { readOnly: true, timeout: busyTimeoutMs });
  const required = new Set(['id', 'file_path', 'file_name', 'ocr_text', 'reviewed']);
  const columns = new Set(source.prepare('PRAGMA table_info(source_images)').all().map((row) => String(row.name).toLowerCase()));
  const missing = [...required].filter((name) => !columns.has(name));
  if (missing.length || !source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='source_images'").get()) {
    throw new Error(`source_images is not compatible; missing columns: ${missing.join(', ') || '(table missing)'}`);
  }

  // Keep one consistent read snapshot while copying, avoiding an inconsistent index if OCR changes mid-build.
  source.exec('BEGIN');
  sourceTransaction = true;
  const totals = source.prepare('SELECT COUNT(*) AS count, COALESCE(MAX(id), 0) AS max_id FROM source_images').get();
  const sourceCount = Number(totals.count);
  const sourceMaxId = Number(totals.max_id);
  console.log(`Building Vaporetto-pretokenized Japanese index from ${sourceCount} OCR records.`);

  target = new DatabaseSync(stagingPath, { timeout: busyTimeoutMs, allowExtension: true });
  target.loadExtension(extensionPath, 'sqlite3_vaporetto_init');
  target.enableLoadExtension(false);
  target.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=NORMAL;');
  target.exec(`
    CREATE TABLE japanese_search_meta (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version INTEGER NOT NULL,
      tokenizer TEXT NOT NULL,
      indexed_at TEXT NOT NULL,
      source_record_count INTEGER NOT NULL,
      source_max_id INTEGER NOT NULL
    );
    CREATE TABLE japanese_documents (
      source_id INTEGER PRIMARY KEY,
      file_path TEXT,
      file_name TEXT,
      reviewed INTEGER,
      ocr_text TEXT NOT NULL
    );
    CREATE INDEX japanese_documents_label_idx ON japanese_documents(file_path);
    CREATE INDEX japanese_documents_reviewed_idx ON japanese_documents(reviewed);
    CREATE VIRTUAL TABLE japanese_fts USING fts5(
      search_text,
      content='',
      tokenize='unicode61'
    );
  `);
  target.exec('BEGIN IMMEDIATE');
  targetTransaction = true;
  const insert = target.prepare(`
    INSERT INTO japanese_documents(source_id, file_path, file_name, reviewed, ocr_text)
    VALUES (?, ?, ?, ?, ?)
  `);
  const tokenize = target.prepare("SELECT vaporetto_split(?, ' ') AS tokens");
  const insertFts = target.prepare('INSERT INTO japanese_fts(rowid, search_text) VALUES (?, ?)');
  const select = source.prepare('SELECT id, file_path, file_name, reviewed, ocr_text FROM source_images ORDER BY id');
  let imported = 0;
  for (const row of select.iterate()) {
    const ocrText = String(row.ocr_text ?? '');
    insert.run(row.id, row.file_path ?? null, row.file_name ?? null, row.reviewed ?? null, ocrText);
    const tokenized = tokenize.get(ocrText)?.tokens ?? '';
    // unicode61 is deliberately used only after Vaporetto has inserted explicit
    // word boundaries. The same normalization path is used to build query terms.
    insertFts.run(row.id, searchableTokens(tokenized).join(' '));
    imported += 1;
    if (imported % 1000 === 0) console.log(`Tokenized and indexed ${imported}/${sourceCount} records...`);
  }
  if (imported !== sourceCount) {
    throw new Error(`Source changed or could not be read consistently: expected ${sourceCount} rows, copied ${imported}`);
  }
  // Release the source read snapshot before metadata validation and final replacement.
  source.exec('COMMIT');
  sourceTransaction = false;

  target.prepare(`
    INSERT INTO japanese_search_meta(singleton, schema_version, tokenizer, indexed_at, source_record_count, source_max_id)
    VALUES (1, 2, 'vaporetto-pretokenized-unicode61', ?, ?, ?)
  `).run(new Date().toISOString(), sourceCount, sourceMaxId);
  target.exec('COMMIT');
  targetTransaction = false;

  // Validate both the Vaporetto query tokenizer and FTS5 query parser before replacing the prior snapshot.
  const probe = target.prepare("SELECT vaporetto_split('吾輩は猫である', ' ') AS tokens").get();
  const probeTokens = searchableTokens(probe?.tokens);
  if (probeTokens.length === 0) throw new Error('sqlite-vaporetto tokenizer returned no searchable tokens for the smoke-test text');
  const probeQuery = probeTokens.map(quoteFts5Token).join(' OR ');
  target.prepare('SELECT rowid FROM japanese_fts WHERE japanese_fts MATCH ? LIMIT 1').get(probeQuery);

  target.close();
  target = undefined;
  source.close();
  source = undefined;
  renameSync(stagingPath, indexPath);
  console.log(`Japanese search index built: ${indexPath}`);
  console.log(`Records: ${sourceCount}; max source ID: ${sourceMaxId}; indexed at: ${new Date().toISOString()}`);
  console.log('Index schema v2 (Vaporetto-pretokenized + unicode61) is ready. Restart the MCP server after rebuilding.');
} catch (error) {
  if (targetTransaction) {
    try { target?.exec('ROLLBACK'); } catch { /* Best-effort cleanup. */ }
  }
  if (sourceTransaction) {
    try { source?.exec('ROLLBACK'); } catch { /* Best-effort cleanup. */ }
  }
  closeQuietly(target);
  closeQuietly(source);
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { rmSync(`${stagingPath}${suffix}`, { force: true }); } catch { /* Best effort. */ }
  }
  console.error('Japanese index build failed; the previous index, if any, was not replaced.');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

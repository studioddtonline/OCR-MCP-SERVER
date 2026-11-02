import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';

const extensionPath = resolve(process.argv.find((arg) => arg.startsWith('--extension='))?.slice('--extension='.length)
  ?? process.env.SQLITE_VAPORETTO_EXTENSION
  ?? 'native/sqlite-vaporetto/libsqlite_vaporetto.so');
const db = new DatabaseSync(':memory:', { allowExtension: true });
const SEARCHABLE_TOKEN = /[\p{L}\p{N}]/u;
const tokensFrom = (value) => String(value ?? '').split(/\s+/u).filter((token) => token && SEARCHABLE_TOKEN.test(token));
const quoteToken = (token) => `"${token.replace(/"/gu, '""')}"`;
try {
  db.loadExtension(extensionPath, 'sqlite3_vaporetto_init');
  db.enableLoadExtension(false);
  const tokenized = db.prepare("SELECT vaporetto_split('東京特許許可局', '/') AS value").get().value;
  if (typeof tokenized !== 'string' || tokenized.length === 0) throw new Error('vaporetto_split returned no tokens');
  db.exec("CREATE VIRTUAL TABLE smoke USING fts5(body, tokenize='unicode61');");
  const searchable = tokensFrom(db.prepare("SELECT vaporetto_split('東京特許許可局', ' ') AS value").get().value);
  if (searchable.length === 0) throw new Error('Vaporetto did not produce searchable terms');
  db.prepare('INSERT INTO smoke(rowid, body) VALUES (1, ?)').run(searchable.join(' '));
  const expression = searchable.map(quoteToken).join(' OR ');
  const hit = db.prepare('SELECT rowid FROM smoke WHERE smoke MATCH ? LIMIT 1').get(expression);
  if (hit?.rowid !== 1) throw new Error('FTS5 MATCH smoke test did not find the tokenized sample');
  console.log('sqlite-vaporetto loaded successfully.');
  console.log(`Tokenization sample: ${tokenized}.`);
  console.log('Vaporetto pretokenization + unicode61 FTS5 MATCH smoke test passed.');
} finally {
  db.close();
}

import { DatabaseSync } from "node:sqlite";

export const SOURCE_IMAGES_SCHEMA_SQL = `CREATE TABLE source_images (
  id INTEGER PRIMARY KEY,
  file_path TEXT,
  file_name TEXT,
  ocr_text TEXT,
  reviewed INTEGER NOT NULL DEFAULT 0
);`;

export const IMAGES_FTS_SCHEMA_SQL = `CREATE VIRTUAL TABLE images_fts USING fts5(
  ocr_text, content='source_images', content_rowid='id', tokenize='trigram'
);`;

export interface OcrFixtureRow {
  id: number;
  label: string;
  fileName: string;
  text: string;
  reviewed: number;
}

export const DEFAULT_OCR_ROWS: OcrFixtureRow[] = [
  { id: 1, label: "Book A", fileName: "020.webp", text: "sample OCR one", reviewed: 1 },
  { id: 2, label: "Book A", fileName: "021.webp", text: "sample OCR two", reviewed: 0 }
];

/** Create the canonical OCR test schema and optional rows in a file or in-memory DB. */
export function createOcrFixtureDatabase(
  filename: string,
  rows: readonly OcrFixtureRow[] = DEFAULT_OCR_ROWS
): DatabaseSync {
  const db = new DatabaseSync(filename);
  db.exec(`${SOURCE_IMAGES_SCHEMA_SQL} ${IMAGES_FTS_SCHEMA_SQL}`);
  const insert = db.prepare(
    "INSERT INTO source_images (id, file_path, file_name, ocr_text, reviewed) VALUES (?, ?, ?, ?, ?)"
  );
  for (const row of rows) insert.run(row.id, row.label, row.fileName, row.text, row.reviewed);
  if (rows.length > 0) db.exec("INSERT INTO images_fts(images_fts) VALUES ('rebuild')");
  return db;
}

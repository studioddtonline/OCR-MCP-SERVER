import type { DatabaseSync } from "node:sqlite";

/** Load sqlite-vaporetto's explicit extension entry point for integration-test index setup. */
export function loadVaporettoExtension(db: DatabaseSync, extensionPath: string): void {
  const loadExtension = db.loadExtension as unknown as (
    this: DatabaseSync,
    path: string,
    entryPoint?: string,
  ) => void;
  loadExtension.call(db, extensionPath, "sqlite3_vaporetto_init");
}

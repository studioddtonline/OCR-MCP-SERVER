import type { DatabaseSync } from "node:sqlite";

/**
 * Load sqlite-vaporetto by its explicit SQLite extension entry point.
 *
 * The runtime supported by this project (Node.js >=22.16) accepts the optional
 * entryPoint argument, but the locked @types/node 22 declaration exposes only
 * loadExtension(path). Keep the compatibility cast in one place rather than
 * scattering type suppressions across production and test code.
 */
export function loadVaporettoExtension(db: DatabaseSync, extensionPath: string): void {
  const loadExtension = db.loadExtension as unknown as (
    this: DatabaseSync,
    path: string,
    entryPoint?: string,
  ) => void;
  loadExtension.call(db, extensionPath, "sqlite3_vaporetto_init");
}

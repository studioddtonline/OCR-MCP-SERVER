import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Shared helpers keep temporary-directory setup and cleanup consistent across tests. */
export function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export async function createTempDirAsync(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export function removeTempDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

export async function removeTempDirAsync(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

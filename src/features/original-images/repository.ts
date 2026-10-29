import { constants } from "node:fs";
import { access, lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { basename, join, relative, resolve, sep } from "node:path";
import { ClientSafeError, isNotFoundError } from "../../shared/errors.js";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const STAT_CONCURRENCY = 16;
const MAX_CONCURRENT_IMAGE_READS = 2;
// MCP server instances are created per HTTP request, so this gate must be module-wide.
let activeImageReads = 0;
const BOOK_DIRECTORY_COLLATOR = new Intl.Collator(undefined, { sensitivity: "base" });
const IMAGE_NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

// Collator can consider differently-cased/numerically equivalent names equal. Use code-unit
// order as a deterministic tie-break so the output does not depend on readdir() order.
function compareNames(a: string, b: string, collator: Intl.Collator): number {
  const localized = collator.compare(a, b);
  if (localized !== 0) return localized;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Natural, case-insensitive image-name ordering with a deterministic code-unit tie-break. */
export function compareImageNames(a: string, b: string): number {
  return compareNames(a, b, IMAGE_NAME_COLLATOR);
}

export interface OriginalImageEntry {
  fileName: string;
  sizeBytes: number;
}

function assertSimpleName(value: string, kind: string): void {
  if (!value || value === "." || value === ".." || basename(value) !== value || value.includes("/") || value.includes("\\") || value.includes("\0")) {
    throw new ClientSafeError(`Invalid ${kind}: expected a single directory or file name`);
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`);
}

function mimeTypeFor(fileName: string): string {
  const ext = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
  switch (ext) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    default: throw new ClientSafeError("Unsupported image format");
  }
}

/** 書籍ディレクトリを検証して実パスを返す。見つからない・シンボリックリンク・ルート外は同じ「見つからない」扱い。 */
async function resolveBookDirectory(root: string, bookDirectory: string): Promise<string> {
  const notFound = () => new ClientSafeError(`Book directory not found: ${bookDirectory}`);
  const bookPath = join(root, bookDirectory);
  let info;
  try { info = await lstat(bookPath); }
  catch (error) { throw isNotFoundError(error) ? notFound() : error; }
  if (!info.isDirectory() || info.isSymbolicLink()) throw notFound();
  const actualBookPath = await realpath(bookPath);
  if (!isInside(root, actualBookPath)) throw new ClientSafeError("Book directory resolves outside the configured root");
  return actualBookPath;
}

export class OriginalImageRepository {
  constructor(private readonly configuredRootPath: string | undefined) {}

  private async root(): Promise<string> {
    if (!this.configuredRootPath) {
      throw new ClientSafeError("Original image storage is not configured");
    }
    try {
      const resolved = await realpath(resolve(this.configuredRootPath));
      const info = await stat(resolved);
      if (!info.isDirectory()) throw new Error("Original image root path is not a directory");
      await access(resolved, constants.R_OK | constants.X_OK);
      return resolved;
    } catch (error) {
      // Node のエラーメッセージにはルートのローカルパスが含まれるため、クライアント向けには固定文言にする。
      throw new ClientSafeError("Original image storage is unavailable", { cause: error });
    }
  }

  async checkAtStartup(): Promise<void> {
    const root = await this.root();
    await readdir(root);
  }

  async listBookDirectories(limit = 200): Promise<{ directories: string[]; returned: number; limit: number }> {
    const root = await this.root();
    const entries = await readdir(root, { withFileTypes: true });
    const directories = entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort((a, b) => compareNames(a, b, BOOK_DIRECTORY_COLLATOR))
      .slice(0, limit);
    return { directories, returned: directories.length, limit };
  }

  async listImages(bookDirectory: string, limit = 500, offset = 0): Promise<{ bookDirectory: string; images: OriginalImageEntry[]; returned: number; limit: number; offset: number; nextOffset: number | null }> {
    assertSimpleName(bookDirectory, "book directory");
    const root = await this.root();
    const actualBookPath = await resolveBookDirectory(root, bookDirectory);
    const entries = await readdir(actualBookPath, { withFileTypes: true });
    // Filter and sort names first. Only stat files that can actually enter the response;
    // the previous implementation stat'ed every image and discarded most of them afterward.
    const candidates = entries
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && IMAGE_EXTENSIONS.has(extnameLower(entry.name)))
      .map((entry) => entry.name)
      .sort(compareImageNames);

    const page = candidates.slice(offset, offset + limit);
    const images: OriginalImageEntry[] = [];
    for (let start = 0; start < page.length; start += STAT_CONCURRENCY) {
      const batch = page.slice(start, start + STAT_CONCURRENCY);
      const results = await Promise.all(batch.map(async (fileName): Promise<OriginalImageEntry | null> => {
        try {
          const fileInfo = await lstat(join(actualBookPath, fileName));
          return fileInfo.isFile() && !fileInfo.isSymbolicLink() ? { fileName, sizeBytes: fileInfo.size } : null;
        } catch (error) {
          if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
          throw error;
        }
      }));
      for (const entry of results) if (entry) images.push(entry);
    }
    const nextOffset = offset + page.length < candidates.length ? offset + page.length : null;
    return { bookDirectory, images, returned: images.length, limit, offset, nextOffset };
  }

  async getImage(bookDirectory: string, fileName: string): Promise<{ data: string; mimeType: string; sizeBytes: number; bookDirectory: string; fileName: string }> {
    if (activeImageReads >= MAX_CONCURRENT_IMAGE_READS) {
      throw new ClientSafeError("Image retrieval is temporarily busy; retry shortly");
    }
    activeImageReads += 1;
    try {
      return await this.readImage(bookDirectory, fileName);
    } finally {
      activeImageReads -= 1;
    }
  }

  private async readImage(bookDirectory: string, fileName: string): Promise<{ data: string; mimeType: string; sizeBytes: number; bookDirectory: string; fileName: string }> {
    assertSimpleName(bookDirectory, "book directory");
    assertSimpleName(fileName, "image file name");
    const mimeType = mimeTypeFor(fileName);
    const root = await this.root();
    const actualBookPath = await resolveBookDirectory(root, bookDirectory);
    const imagePath = join(actualBookPath, fileName);
    const notFound = () => new ClientSafeError(`Image file not found: ${fileName}`);
    let fileInfo;
    try { fileInfo = await lstat(imagePath); }
    catch (error) { throw isNotFoundError(error) ? notFound() : error; }
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) throw notFound();
    const actualImagePath = await realpath(imagePath);
    if (!isInside(actualBookPath, actualImagePath)) throw new ClientSafeError("Image path resolves outside the book directory");
    if (fileInfo.size > MAX_IMAGE_BYTES) throw new ClientSafeError(`Image exceeds the ${MAX_IMAGE_BYTES} byte size limit`);
    const handle = await open(actualImagePath, "r");
    let bytes: Buffer;
    try {
      const openedInfo = await handle.stat();
      if (!openedInfo.isFile()) throw notFound();
      if (openedInfo.size > MAX_IMAGE_BYTES) throw new ClientSafeError(`Image exceeds the ${MAX_IMAGE_BYTES} byte size limit`);
      // Read into one size-bounded buffer to avoid retaining both chunk buffers and a concatenated copy.
      const expectedSize = openedInfo.size;
      const buffer = Buffer.allocUnsafe(expectedSize);
      let total = 0;
      while (total < expectedSize) {
        const { bytesRead } = await handle.read(buffer, total, expectedSize - total, total);
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      const extra = Buffer.allocUnsafe(1);
      const growth = await handle.read(extra, 0, 1, total);
      if (growth.bytesRead > 0) {
        if (total >= MAX_IMAGE_BYTES) throw new ClientSafeError(`Image exceeds the ${MAX_IMAGE_BYTES} byte size limit`);
        throw new ClientSafeError("Image changed while being read; retry the request");
      }
      bytes = buffer.subarray(0, total);
    } finally {
      await handle.close();
    }
    return { data: bytes.toString("base64"), mimeType, sizeBytes: bytes.byteLength, bookDirectory, fileName };
  }
}

function extnameLower(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot < 0 ? "" : fileName.slice(dot).toLowerCase();
}

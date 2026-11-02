import { constants } from "node:fs";
import { open, lstat, realpath, stat, access } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { basename, join, relative, resolve, sep } from "node:path";
import { parentPort } from "node:worker_threads";

if (!parentPort) throw new Error("Original image Worker requires a parent port");

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;
let activeJob;

class WorkerClientSafeError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ClientSafeError";
    this.clientSafe = true;
  }
}

function assertSimpleName(value, kind) {
  if (!value || value === "." || value === ".." || basename(value) !== value || value.includes("/") || value.includes("\\") || value.includes("\0")) {
    throw new WorkerClientSafeError(`Invalid ${kind}: expected a single directory or file name`);
  }
}

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`);
}

function mimeTypeFor(fileName) {
  const dot = fileName.lastIndexOf(".");
  const ext = (dot < 0 ? "" : fileName.slice(dot)).toLowerCase();
  switch (ext) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    default: throw new WorkerClientSafeError("Unsupported image format");
  }
}

async function resolveRoot(configuredRootPath) {
  if (!configuredRootPath) throw new WorkerClientSafeError("Original image storage is not configured");
  try {
    const resolved = await realpath(resolve(configuredRootPath));
    const info = await stat(resolved);
    if (!info.isDirectory()) throw new Error("Original image root path is not a directory");
    await access(resolved, constants.R_OK | constants.X_OK);
    return resolved;
  } catch (error) {
    throw new WorkerClientSafeError("Original image storage is unavailable", { cause: error });
  }
}

async function resolveBookDirectory(root, bookDirectory) {
  const notFound = () => new WorkerClientSafeError(`Book directory not found: ${bookDirectory}`);
  const bookPath = join(root, bookDirectory);
  let info;
  try { info = await lstat(bookPath); }
  catch (error) {
    if (error && typeof error === "object" && (error.code === "ENOENT" || error.code === "ENOTDIR")) throw notFound();
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw notFound();
  const actualBookPath = await realpath(bookPath);
  if (!isInside(root, actualBookPath)) throw new WorkerClientSafeError("Book directory resolves outside the configured root");
  return actualBookPath;
}

async function readImage(rootPath, bookDirectory, fileName, signal) {
  assertSimpleName(bookDirectory, "book directory");
  assertSimpleName(fileName, "image file name");
  const mimeType = mimeTypeFor(fileName);
  const root = await resolveRoot(rootPath);
  signal.throwIfAborted();
  const actualBookPath = await resolveBookDirectory(root, bookDirectory);
  const imagePath = join(actualBookPath, fileName);
  const notFound = () => new WorkerClientSafeError(`Image file not found: ${fileName}`);
  let fileInfo;
  try { fileInfo = await lstat(imagePath); }
  catch (error) {
    if (error && typeof error === "object" && (error.code === "ENOENT" || error.code === "ENOTDIR")) throw notFound();
    throw error;
  }
  if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) throw notFound();
  const actualImagePath = await realpath(imagePath);
  if (!isInside(actualBookPath, actualImagePath)) throw new WorkerClientSafeError("Image path resolves outside the book directory");
  if (fileInfo.size > MAX_IMAGE_BYTES) throw new WorkerClientSafeError(`Image exceeds the ${MAX_IMAGE_BYTES} byte size limit`);
  signal.throwIfAborted();

  const handle = await open(actualImagePath, "r");
  let bytes;
  try {
    const openedInfo = await handle.stat();
    if (!openedInfo.isFile()) throw notFound();
    if (openedInfo.size > MAX_IMAGE_BYTES) throw new WorkerClientSafeError(`Image exceeds the ${MAX_IMAGE_BYTES} byte size limit`);
    const expectedSize = openedInfo.size;
    const buffer = Buffer.allocUnsafe(expectedSize);
    let total = 0;
    while (total < expectedSize) {
      signal.throwIfAborted();
      const chunkLength = Math.min(READ_CHUNK_BYTES, expectedSize - total);
      const { bytesRead } = await handle.read(buffer, total, chunkLength, total);
      signal.throwIfAborted();
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    signal.throwIfAborted();
    const growth = await handle.read(extra, 0, 1, total);
    signal.throwIfAborted();
    if (growth.bytesRead > 0) {
      if (total >= MAX_IMAGE_BYTES) throw new WorkerClientSafeError(`Image exceeds the ${MAX_IMAGE_BYTES} byte size limit`);
      throw new WorkerClientSafeError("Image changed while being read; retry the request");
    }
    bytes = buffer.subarray(0, total);
  } finally {
    await handle.close();
  }

  signal.throwIfAborted();
  const data = bytes.toString("base64");
  signal.throwIfAborted();
  return { data, mimeType, sizeBytes: bytes.byteLength, bookDirectory, fileName };
}

function serializeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const causeMessage = error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined;
  return {
    name: error instanceof Error ? error.name : "Error",
    message,
    ...(causeMessage ? { causeMessage } : {}),
    clientSafe: error instanceof WorkerClientSafeError || error?.clientSafe === true,
  };
}

async function runRead(message) {
  const controller = new AbortController();
  activeJob = { id: message.id, controller };
  try {
    const result = await readImage(message.rootPath, message.bookDirectory, message.fileName, controller.signal);
    if (controller.signal.aborted) parentPort.postMessage({ type: "cancelled", id: message.id });
    else parentPort.postMessage({ type: "result", id: message.id, result });
  } catch (error) {
    if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      parentPort.postMessage({ type: "cancelled", id: message.id });
    } else {
      parentPort.postMessage({ type: "failure", id: message.id, error: serializeError(error) });
    }
  } finally {
    if (activeJob?.id === message.id) activeJob = undefined;
  }
}

parentPort.on("message", (message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "cancel") {
    if (activeJob?.id === message.id) activeJob.controller.abort();
    return;
  }
  if (message.type === "read") {
    if (activeJob) {
      parentPort.postMessage({
        type: "failure",
        id: message.id,
        error: { name: "Error", message: "Image Worker received overlapping read jobs", clientSafe: false },
      });
      return;
    }
    void runRead(message);
  }
});

parentPort.postMessage({ type: "ready" });

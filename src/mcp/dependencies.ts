import type { OcrRepository } from "../features/ocr/repository.js";
import type { OcrWriteToolsOptions } from "../features/ocr/write-tools.js";
import type { JapaneseSearchToolOptions } from "../features/japanese-search/tools.js";
import type { OriginalImageRepository } from "../features/original-images/repository.js";

/** Runtime-owned resources needed to create a fresh MCP server for each HTTP request. */
export interface McpRuntimeDependencies {
  repo: OcrRepository;
  ocrWrite: Pick<OcrWriteToolsOptions, "repository" | "unavailableReason" | "log">;
  japaneseSearch: Pick<JapaneseSearchToolOptions, "repository" | "unavailableReason">;
  /** One Runtime-owned repository keeps the image FIFO shared across per-request MCP servers. */
  originalImages: OriginalImageRepository;
}

import type { OcrRepository } from "../features/ocr/repository.js";
import type { OcrSearch } from "ocr-search";
import type { OcrWriteToolsOptions } from "../features/ocr/write-tools.js";
import type { OriginalImageRepository } from "../features/original-images/repository.js";

/** Runtime-owned resources needed to create a fresh MCP server for each HTTP request. */
export interface McpRuntimeDependencies {
  repo: OcrRepository;
  search: { repository?: OcrSearch; unavailableReason?: string; japaneseUnavailableReason?: string };
  ocrWrite: Pick<OcrWriteToolsOptions, "repository" | "unavailableReason" | "log">;
  originalImages: OriginalImageRepository;
}

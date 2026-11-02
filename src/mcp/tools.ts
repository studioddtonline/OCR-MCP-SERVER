import { McpServer } from "@modelcontextprotocol/server";
import type { AppConfig } from "../config/types.js";
import type { McpRuntimeDependencies } from "./dependencies.js";
import { SCOPE_WRITE } from "../auth/scopes.js";
import { createOcrToolSchemas, registerOcrTools, type OcrToolSchemas } from "../features/ocr/tools.js";
import { createOriginalImageToolSchemas, registerOriginalImageTools, type OriginalImageToolSchemas } from "../features/original-images/tools.js";
import { registerOcrWriteTool } from "../features/ocr/write-tools.js";
import { registerJapaneseSearchTool } from "../features/japanese-search/tools.js";

/** Flat schema shape retained for callers that create configuration-specific schemas at startup. */
export type McpToolSchemas = OcrToolSchemas & OriginalImageToolSchemas;

export function createMcpToolSchemas(config: AppConfig): McpToolSchemas {
  return {
    ...createOcrToolSchemas({ maxLimit: config.search.maxLimit }),
    ...createOriginalImageToolSchemas()
  };
}

/** Creates a fresh MCP server while reusing Runtime-owned feature repositories. */
export function createMcpServer(
  runtime: McpRuntimeDependencies,
  config: AppConfig,
  schemas: McpToolSchemas = createMcpToolSchemas(config)
): McpServer {
  const server = new McpServer({ name: "ocr-mcp-server", version: "0.1.0" });

  registerOcrTools(server, runtime.repo, {
    defaultLimit: config.search.defaultLimit,
    maxLimit: config.search.maxLimit,
    snippetLength: config.search.snippetLength
  }, {
    searchOcr: schemas.searchOcr,
    getOcrRecord: schemas.getOcrRecord,
    listSourceLabels: schemas.listSourceLabels,
    getOcrStats: schemas.getOcrStats
  });

  if (config.ocrWrite?.enabled) {
    registerOcrWriteTool(server, {
      repository: runtime.ocrWrite.repository,
      unavailableReason: runtime.ocrWrite.unavailableReason,
      log: runtime.ocrWrite.log,
      requiredScope: SCOPE_WRITE,
    });
  }

  if (config.japaneseSearch?.enabled) {
    registerJapaneseSearchTool(server, {
      repository: runtime.japaneseSearch.repository,
      unavailableReason: runtime.japaneseSearch.unavailableReason,
      maxLimit: config.japaneseSearch.maxLimit ?? 20,
    });
  }

  registerOriginalImageTools(server, { repository: runtime.originalImages }, {
    listOriginalBookDirectories: schemas.listOriginalBookDirectories,
    listOriginalImages: schemas.listOriginalImages,
    getOriginalImage: schemas.getOriginalImage
  });

  return server;
}

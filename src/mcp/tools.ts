import { McpServer } from "@modelcontextprotocol/server";
import type { AppConfig } from "../config/types.js";
import type { OcrRepository } from "../features/ocr/repository.js";
import { SCOPE_WRITE } from "../auth/scopes.js";
import { createOcrToolSchemas, registerOcrTools, type OcrToolSchemas } from "../features/ocr/tools.js";
import { createOriginalImageToolSchemas, registerOriginalImageTools, type OriginalImageToolSchemas } from "../features/original-images/tools.js";
import { registerOcrWriteTool, type OcrWriteToolsOptions } from "../features/ocr/write-tools.js";

/** Flat schema shape retained for callers that create configuration-specific schemas at startup. */
export type McpToolSchemas = OcrToolSchemas & OriginalImageToolSchemas;

export function createMcpToolSchemas(config: AppConfig): McpToolSchemas {
  return {
    ...createOcrToolSchemas({ maxLimit: config.search.maxLimit }),
    ...createOriginalImageToolSchemas()
  };
}

/** Creates a fresh MCP server and composes feature-owned tools without moving feature logic here. */
export function createMcpServer(
  repo: OcrRepository,
  config: AppConfig,
  schemas: McpToolSchemas = createMcpToolSchemas(config),
  ocrWrite?: OcrWriteToolsOptions
): McpServer {
  const server = new McpServer({ name: "ocr-mcp-server", version: "0.1.0" });

  registerOcrTools(server, repo, {
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
    registerOcrWriteTool(server, { ...(ocrWrite ?? { unavailableReason: "OCR write repository was not initialized" }), requiredScope: SCOPE_WRITE });
  }

  registerOriginalImageTools(server, { rootPath: config.originalImages?.rootPath }, {
    listOriginalBookDirectories: schemas.listOriginalBookDirectories,
    listOriginalImages: schemas.listOriginalImages,
    getOriginalImage: schemas.getOriginalImage
  });

  return server;
}

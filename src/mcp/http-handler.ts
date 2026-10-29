import { createMcpHandler } from "@modelcontextprotocol/server";
import type { AppConfig } from "../config/types.js";
import type { OcrRepository } from "../features/ocr/repository.js";
import { createMcpServer, createMcpToolSchemas } from "./tools.js";
import type { OcrWriteToolsOptions } from "../features/ocr/write-tools.js";

/** HTTP-capable MCP handler produced by the SDK adapter. */
export type McpHttpHandler = ReturnType<typeof createMcpHandler>;

/** Compose MCP tools outside the HTTP transport layer. Schemas are created once per configuration. */
export function createMcpHttpHandler(repo: OcrRepository, config: AppConfig, ocrWrite?: OcrWriteToolsOptions): McpHttpHandler {
  const toolSchemas = createMcpToolSchemas(config);
  return createMcpHandler(() => createMcpServer(repo, config, toolSchemas, ocrWrite));
}

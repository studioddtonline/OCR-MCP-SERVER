import { createMcpHandler } from "@modelcontextprotocol/server";
import type { AppConfig } from "../config/types.js";
import { createMcpServer, createMcpToolSchemas } from "./tools.js";
import type { McpRuntimeDependencies } from "./dependencies.js";

/** HTTP-capable MCP handler produced by the SDK adapter. */
export type McpHttpHandler = ReturnType<typeof createMcpHandler>;

/** Compose tools outside the HTTP transport layer. Schemas are created once per configuration. */
export function createMcpHttpHandler(runtime: McpRuntimeDependencies, config: AppConfig): McpHttpHandler {
  const toolSchemas = createMcpToolSchemas(config);
  return createMcpHandler(() => createMcpServer(runtime, config, toolSchemas));
}

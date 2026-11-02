import "dotenv/config";
import { loadConfig } from "./config/load.js";
import { bootstrap } from "./app/bootstrap.js";
import { startHttpServer } from "./http/server.js";
import { createMcpHttpHandler } from "./mcp/http-handler.js";

function main() {
  const config = loadConfig();
  const runtime = bootstrap(config);
  const mcpHandler = createMcpHttpHandler(runtime, config);
  const server = startHttpServer(config, mcpHandler, runtime.oauth);

  const shutdown = () => {
    server.close(() => {
      runtime.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.error(`OCR MCP server (auth: ${config.auth.mode}) listening on ${config.server.host}:${config.server.port}; MCP path ${config.server.mcpPath}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

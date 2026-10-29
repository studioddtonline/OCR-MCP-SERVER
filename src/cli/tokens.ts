import "dotenv/config";
import { loadConfig } from "../config/load.js";
import { TokenStore } from "../auth/token-store.js";
import { runTokenCli } from "./tokens-core.js";

try {
  const config = loadConfig();
  if (!config.staticTokens) {
    throw new Error("staticTokens.databasePath が設定されていません (config/config.json を確認してください)");
  }
  const store = new TokenStore(config.staticTokens.databasePath);
  const mcpUrl = config.server.publicBaseUrl ? new URL(config.server.mcpPath, config.server.publicBaseUrl).toString() : undefined;
  try {
    process.exitCode = runTokenCli(
      process.argv.slice(2),
      store,
      { out: (line) => console.log(line), err: (line) => console.error(line) },
      mcpUrl ? { mcpUrl } : {},
    );
  } finally {
    store.close();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

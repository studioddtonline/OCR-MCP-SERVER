import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateConfig } from "./validate.js";
import type { AppConfig } from "./types.js";

/** Read environment variables only here, keeping config precedence and legacy-env handling centralized. */
export function loadConfig(): AppConfig {
  const configPath = resolve(process.env.MCP_CONFIG_PATH ?? "config/config.json");
  const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
  const config = validateConfig(parsed);
  return {
    ...config,
    // Preserve the old startup warning without making bootstrap read process.env directly.
    legacyBearerTokenPresent: Boolean(process.env.MCP_BEARER_TOKEN)
  };
}

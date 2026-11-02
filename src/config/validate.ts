import { resolve } from "node:path";
import { ConfigSchema } from "./schema.js";
import type { AppConfig } from "./types.js";

/** Parse and normalize the v1 configuration without reading process environment variables. */
export function validateConfig(input: unknown): AppConfig {
  const parsedConfig = ConfigSchema.parse(input);
  const derivedAllowedHosts = parsedConfig.server.allowedHosts
    ?? (parsedConfig.server.publicBaseUrl
      ? [new URL(parsedConfig.server.publicBaseUrl).hostname.toLowerCase()]
      : undefined);
  if (!derivedAllowedHosts) {
    throw new Error(
      "server.allowedHosts is required when server.publicBaseUrl is not configured"
    );
  }
  const config: AppConfig = {
    ...parsedConfig,
    server: {
      ...parsedConfig.server,
      allowedHosts: derivedAllowedHosts.map((host) => host.toLowerCase())
    }
  };

  if (!config.database.path.startsWith("/")) {
    throw new Error("database.path must be an absolute path");
  }
  if (config.originalImages && !config.originalImages.rootPath.startsWith("/")) {
    throw new Error("originalImages.rootPath must be an absolute path");
  }
  if (config.japaneseSearch?.enabled) {
    if (!config.japaneseSearch.indexPath) {
      throw new Error("japaneseSearch.indexPath is required when japaneseSearch.enabled is true");
    }
    if (!config.japaneseSearch.extensionPath) {
      throw new Error("japaneseSearch.extensionPath is required when japaneseSearch.enabled is true");
    }
    if (!config.japaneseSearch.indexPath.startsWith("/")) {
      throw new Error("japaneseSearch.indexPath must be an absolute path");
    }
    if (!config.japaneseSearch.extensionPath.startsWith("/")) {
      throw new Error("japaneseSearch.extensionPath must be an absolute path");
    }
    const databasePaths = [
      config.database.path,
      config.japaneseSearch.indexPath,
      ...(config.oauth?.databasePath ? [config.oauth.databasePath] : []),
      ...(config.staticTokens?.databasePath ? [config.staticTokens.databasePath] : []),
    ].map((path) => resolve(path));
    const distinctFiles = new Set(databasePaths);
    const expectedDistinct = 2 + Number(Boolean(config.oauth?.databasePath)) + Number(Boolean(config.staticTokens?.databasePath));
    if (distinctFiles.size !== expectedDistinct) {
      throw new Error("japaneseSearch.indexPath must be different from the OCR, OAuth and static-token database paths");
    }
    if (databasePaths.includes(resolve(config.japaneseSearch.extensionPath))) {
      throw new Error("japaneseSearch.extensionPath must be different from all database paths");
    }
  }
  if (config.ocrWrite?.enabled && config.auth.mode !== "oauth") {
    throw new Error("ocrWrite.enabled requires auth.mode to be \"oauth\"");
  }

  if (config.auth.mode === "oauth") {
    if (!config.oauth) throw new Error("oauth.databasePath is required when auth.mode is \"oauth\"");
    if (!config.oauth.databasePath.startsWith("/")) {
      throw new Error("oauth.databasePath must be an absolute path");
    }
    if (!config.server.publicBaseUrl) {
      throw new Error("server.publicBaseUrl is required when auth.mode is \"oauth\"");
    }
    if (!config.staticTokens) {
      throw new Error("staticTokens.databasePath is required when auth.mode is \"oauth\" (consent-screen login tokens are stored there)");
    }
    if (!config.staticTokens.databasePath.startsWith("/")) {
      throw new Error("staticTokens.databasePath must be an absolute path");
    }
    const distinct = new Set([
      config.database.path,
      config.oauth.databasePath,
      config.staticTokens.databasePath
    ].map((path) => resolve(path)));
    if (distinct.size !== 3) {
      throw new Error("database.path, oauth.databasePath and staticTokens.databasePath must be three different files");
    }
  }

  const publicBase = config.server.publicBaseUrl ? new URL(config.server.publicBaseUrl) : undefined;
  if (publicBase && (
    publicBase.protocol !== "https:" || publicBase.pathname !== "/" || publicBase.search ||
    publicBase.hash || publicBase.username || publicBase.password
  )) {
    throw new Error("server.publicBaseUrl must be an HTTPS origin without a path, query, or credentials");
  }
  if (config.search.defaultLimit > config.search.maxLimit) {
    throw new Error("search.defaultLimit cannot exceed search.maxLimit");
  }
  return config;
}

import type { ParsedConfig } from "./schema.js";

export type AppConfig = Omit<ParsedConfig, "server" | "ocrWrite"> & {
  /** Optional in manually constructed test/runtime configs; validated config defaults this to disabled. */
  ocrWrite?: ParsedConfig["ocrWrite"];
  server: Omit<ParsedConfig["server"], "allowedHosts"> & { allowedHosts: string[] };
  /** Runtime metadata from config/load.ts; not a user-configurable JSON key. */
  legacyBearerTokenPresent?: boolean;
};

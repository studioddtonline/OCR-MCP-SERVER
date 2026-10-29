import { z } from "zod";
import { AuthConfigSchema } from "./sections/auth.js";
import { DatabaseConfigSchema } from "./sections/database.js";
import { OAuthConfigSchema } from "./sections/oauth.js";
import { OriginalImagesConfigSchema } from "./sections/original-images.js";
import { OcrWriteConfigSchema } from "./sections/ocr-write.js";
import { SearchConfigSchema } from "./sections/search.js";
import { ServerConfigSchema } from "./sections/server.js";
import { StaticTokensConfigSchema } from "./sections/static-tokens.js";

// Section schemas live under config/sections so this composition layer remains a leaf:
// it depends only on config definitions, never on feature implementations.
export const ConfigSchema = z.object({
  server: ServerConfigSchema,
  auth: AuthConfigSchema,
  database: DatabaseConfigSchema,
  oauth: OAuthConfigSchema,
  staticTokens: StaticTokensConfigSchema,
  originalImages: OriginalImagesConfigSchema,
  ocrWrite: OcrWriteConfigSchema,
  search: SearchConfigSchema
});

export type ParsedConfig = z.infer<typeof ConfigSchema>;

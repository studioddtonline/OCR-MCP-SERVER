import { DEFAULT_JAPANESE_SEARCH_BUSY_TIMEOUT_MS, DEFAULT_JAPANESE_SEARCH_MAX_LIMIT } from "../constants.js";
import { z } from "zod";

/** Optional Japanese FTS5 index, kept separate from the shared OCR source database. */
export const JapaneseSearchConfigSchema = z.object({
  enabled: z.boolean().default(false),
  indexPath: z.string().min(1).optional(),
  extensionPath: z.string().min(1).optional(),
  busyTimeoutMs: z.number().int().min(0).max(120000).default(DEFAULT_JAPANESE_SEARCH_BUSY_TIMEOUT_MS),
  maxLimit: z.number().int().min(1).max(50).default(DEFAULT_JAPANESE_SEARCH_MAX_LIMIT),
}).default({ enabled: false, busyTimeoutMs: DEFAULT_JAPANESE_SEARCH_BUSY_TIMEOUT_MS, maxLimit: DEFAULT_JAPANESE_SEARCH_MAX_LIMIT });

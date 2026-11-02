import { z } from "zod";

/** Optional Japanese FTS5 index, kept separate from the shared OCR source database. */
export const JapaneseSearchConfigSchema = z.object({
  enabled: z.boolean().default(false),
  indexPath: z.string().min(1).optional(),
  extensionPath: z.string().min(1).optional(),
  busyTimeoutMs: z.number().int().min(0).max(120000).default(500),
  maxLimit: z.number().int().min(1).max(50).default(20),
}).default({ enabled: false, busyTimeoutMs: 500, maxLimit: 20 });

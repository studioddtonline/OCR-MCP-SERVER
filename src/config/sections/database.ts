import { z } from "zod";

export const DatabaseConfigSchema = z.object({
  path: z.string().min(1),
  busyTimeoutMs: z.number().int().min(0).max(120000).default(500)
});

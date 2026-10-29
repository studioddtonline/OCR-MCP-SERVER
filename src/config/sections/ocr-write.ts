import { z } from "zod";

/** OCR write access is deliberately opt-in; all other safety limits are fixed in code. */
export const OcrWriteConfigSchema = z.object({
  enabled: z.boolean().default(false)
}).default({ enabled: false });

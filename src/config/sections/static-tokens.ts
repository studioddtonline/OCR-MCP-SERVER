import { z } from "zod";

// Separate database for named tokens used both for consent-screen login and MCP bearer auth.
export const StaticTokensConfigSchema = z.object({
  databasePath: z.string().min(1)
}).optional();

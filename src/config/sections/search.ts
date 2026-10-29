import { z } from "zod";

export const SearchConfigSchema = z.object({
  defaultLimit: z.number().int().min(1).max(50).default(20),
  maxLimit: z.number().int().min(1).max(100).default(50),
  snippetLength: z.number().int().min(40).max(1000).default(160)
}).default({ defaultLimit: 20, maxLimit: 50, snippetLength: 160 });

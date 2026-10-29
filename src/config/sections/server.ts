import { z } from "zod";

export const ServerConfigSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  publicBaseUrl: z.string().url().optional(),
  mcpPath: z.string().startsWith("/").default("/mcp"),
  // If omitted, validate.ts derives it from publicBaseUrl. Without either value,
  // explicit configuration is required to avoid an unintended public listener.
  allowedHosts: z.array(z.string().min(1)).min(1).optional()
});

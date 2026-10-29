import { z } from "zod";

export const AuthConfigSchema = z.object({
  // Explicit selection prevents a configuration omission from exposing MCP without auth.
  mode: z.enum(["none", "oauth"])
});

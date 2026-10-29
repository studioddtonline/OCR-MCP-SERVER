import { z } from "zod";

export const OAuthConfigSchema = z.object({
  databasePath: z.string().min(1),
  // Claude (web / Desktop / mobile) fixed callback. Loopback callbacks are not included.
  allowedRedirectUris: z.array(z.string().url()).min(1).default(["https://claude.ai/api/mcp/auth_callback"]),
  // Allowlisted hosts for CIMD client_id metadata documents (SSRF protection).
  cimdAllowedHosts: z.array(z.string().min(1)).default(["claude.ai"])
}).optional();

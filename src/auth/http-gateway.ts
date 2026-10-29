import { requireBearerAuth } from "@modelcontextprotocol/server";
import type { AppConfig } from "../config/types.js";
import { createTokenVerifier } from "./bearer.js";
import type { OAuthOptions } from "./options.js";
import { ADVERTISED_SCOPES, SCOPE_READ } from "./scopes.js";
import { createOAuthHandler } from "./oauth/index.js";

export type HttpAuthConfig = Pick<AppConfig, "server" | "auth" | "oauth" | "ocrWrite">;

/** Authentication/OAuth wiring for the HTTP transport, kept separate from request routing. */
export function createHttpAuthGateway(config: HttpAuthConfig, oauth?: OAuthOptions) {
  const origin = config.server.publicBaseUrl ? new URL(config.server.publicBaseUrl).origin : undefined;
  const authRequired = config.auth.mode !== "none";
  const advertisedScopes: readonly string[] = config.ocrWrite?.enabled ? ADVERTISED_SCOPES : [SCOPE_READ];
  const oauthConfigured = config.auth.mode === "oauth";
  const oauthStoresReady = oauth?.status === "ready";
  const resource = origin ? new URL(config.server.mcpPath, origin).toString() : "";

  const authGate = oauthConfigured && origin !== undefined && oauth?.status === "ready"
    ? requireBearerAuth({
        verifier: createTokenVerifier(oauth.store, oauth.tokens, resource),
        requiredScopes: [SCOPE_READ],
      })
    : undefined;
  const oauthHandler = oauthConfigured && origin !== undefined && config.oauth
    ? createOAuthHandler(
        config,
        oauth?.status === "ready" ? oauth.store : undefined,
        oauth?.status === "ready" ? oauth.tokens : undefined,
        {
          unavailableReason: oauth?.status === "unavailable"
            ? oauth.unavailableReason
            : (!oauthStoresReady ? "OAuth databases are unavailable" : undefined),
        },
      )
    : undefined;

  return {
    authRequired,
    authGate,
    oauthHandler,
    advertisedScopes,
    protectedResourceMetadataUrl: origin
      ? new URL(`/.well-known/oauth-protected-resource${config.server.mcpPath}`, origin).toString()
      : undefined,
    unavailableReason(): string {
      if (oauth?.status === "unavailable") return oauth.unavailableReason;
      if (!oauthStoresReady) return "OAuth databases are unavailable";
      return "authentication gate could not be constructed for auth.mode=" + String(config.auth.mode);
    },
  };
}

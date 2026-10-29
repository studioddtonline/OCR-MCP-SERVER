import type { AppConfig } from "../../config/types.js";
import type { OAuthStore } from "../oauth-store.js";
import type { TokenStore } from "../token-store.js";
import { createOAuthContext } from "./context.js";
import { handleAuthorize } from "./routes/authorize.js";
import { handleMetadata } from "./routes/metadata.js";
import { handleRegister } from "./routes/register.js";
import { handleRevoke } from "./routes/revoke.js";
import { handleToken } from "./routes/token.js";
import { handleUnavailableStatefulRoute } from "./routes/unavailable.js";
import type { OAuthAvailableContext, OAuthHandlerOptions, OAuthRoute } from "./types.js";

export type { OAuthHandlerOptions } from "./types.js";

/** Stateful handlers are only constructed with a context whose stores are guaranteed to exist. */
export function oauthRoutes(ctx: OAuthAvailableContext): OAuthRoute[] {
  return [
    (request, url) => handleRegister(ctx, request, url),
    (request, url) => handleAuthorize(ctx, request, url),
    (request, url) => handleToken(ctx, request, url),
    (request, url) => handleRevoke(ctx, request, url),
  ];
}

export function createOAuthHandler(
  config: Pick<AppConfig, "server" | "oauth" | "ocrWrite">,
  store: OAuthStore | undefined,
  tokens: TokenStore | undefined,
  options: OAuthHandlerOptions = {},
) {
  const context = createOAuthContext(config, store, tokens, options);
  const availableRoutes = context.state === "available" ? oauthRoutes(context) : undefined;
  return {
    async fetch(request: Request): Promise<Response | undefined> {
      // Match against one parsed URL, as the monolithic handler did before extraction.
      const url = new URL(request.url);
      // Discovery and CORS preflight remain available even when the stores are unavailable.
      const metadataResponse = await handleMetadata(context, request, url);
      if (metadataResponse !== undefined) return metadataResponse;

      if (context.state === "unavailable") {
        return handleUnavailableStatefulRoute(context, request, url);
      }
      for (const route of availableRoutes ?? []) {
        const response = await route(request, url);
        if (response !== undefined) return response;
      }
      return undefined;
    },
  };
}

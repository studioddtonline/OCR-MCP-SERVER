import type { OAuthStore } from "./oauth-store.js";
import type { TokenStore } from "./token-store.js";

/** Stores and health state required by the HTTP OAuth/authentication layer. */
export type OAuthOptions =
  | {
      status: "ready";
      store: OAuthStore;
      /** Named static tokens (purpose=login for the consent page, purpose=api for MCP Bearer auth). */
      tokens: TokenStore;
    }
  | {
      status: "unavailable";
      /** Why OAuth/static-token storage was unavailable during startup. */
      unavailableReason: string;
    };

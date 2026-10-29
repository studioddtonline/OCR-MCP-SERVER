import type { AppConfig } from "../../config/types.js";
import type { OAuthStore } from "../oauth-store.js";
import type { TokenStore } from "../token-store.js";
import { createCimdResolver, looksLikeUrlClientId } from "../cimd.js";
import {
  ADVERTISED_SCOPES,
  KNOWN_SCOPES,
  parseScopes,
  SCOPE_READ,
} from "../scopes.js";
import { createClientResolver } from "./client-resolver.js";
import { createPageRenderer, renderConsentPage } from "./consent-page.js";
import { LoginLimiter } from "./login-limiter.js";
import { json, oauthError } from "./responses.js";
import type { AuthzRequest, OAuthContext, OAuthContextBase, OAuthHandlerOptions, StringGetter } from "./types.js";

export function createOAuthContext(
  config: Pick<AppConfig, "server" | "oauth" | "ocrWrite">,
  store: OAuthStore | undefined,
  tokens: TokenStore | undefined,
  options: OAuthHandlerOptions = {},
): OAuthContext {
  if (!config.server.publicBaseUrl) throw new Error("server.publicBaseUrl is required for OAuth");
  const issuer = new URL(config.server.publicBaseUrl).origin;
  const resource = new URL(config.server.mcpPath, issuer).toString();
  const metadataPath = `/.well-known/oauth-protected-resource${config.server.mcpPath}`;
  const oauthCfg = config.oauth;
  if (!oauthCfg) throw new Error("oauth config is required");
  const allowedRedirects = new Set(oauthCfg.allowedRedirectUris);
  // The browser applies form-action to the callback navigation after the form POST too.
  const formAction = ["'self'", ...new Set(oauthCfg.allowedRedirectUris.map((uri) => new URL(uri).origin))].join(" ");
  const render = createPageRenderer(formAction);
  const cimd = createCimdResolver({
    allowedHosts: oauthCfg.cimdAllowedHosts,
    allowedRedirectUris: oauthCfg.allowedRedirectUris,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  const storesReady = store !== undefined && tokens !== undefined && !options.unavailableReason;
  const advertisedScopes = config.ocrWrite?.enabled ? ADVERTISED_SCOPES : [SCOPE_READ];
  const allowedScopes = new Set(advertisedScopes);
  const resolveClient = createClientResolver(storesReady ? store : undefined, cimd);
  const trimSlash = (value: string) => value.replace(/\/+$/, "");
  /** resource is optional; when present, require a match while tolerating a trailing slash. */
  const resourceOk = (value: string | null | undefined) => !value || trimSlash(value) === trimSlash(resource);
  /** Ignore unknown scopes; ocr:read is always included. */
  const requestedScopes = (raw: string | null | undefined): string[] => [
    ...new Set([SCOPE_READ, ...parseScopes(raw).filter((scope) => KNOWN_SCOPES.has(scope) && allowedScopes.has(scope))]),
  ];
  async function parseAuthzRequest(get: StringGetter): Promise<AuthzRequest | undefined> {
    const clientId = get("client_id") ?? "";
    const redirectUri = get("redirect_uri") ?? "";
    const challenge = get("code_challenge") ?? "";
    const state = get("state") ?? "";
    const client = await resolveClient(clientId);
    if (
      !client ||
      !client.redirectUris.includes(redirectUri) ||
      !allowedRedirects.has(redirectUri) ||
      get("response_type") !== "code" ||
      get("code_challenge_method") !== "S256" ||
      !/^[A-Za-z0-9_-]{43,128}$/.test(challenge) ||
      !state ||
      state.length > 2048 ||
      !resourceOk(get("resource"))
    ) return undefined;
    return { client, clientId, redirectUri, challenge, state, requested: requestedScopes(get("scope")) };
  }
  const invalidAuthzPage = () => render(
    "認可リクエストを拒否しました",
    "<p>要求されたクライアントまたはパラメーターが無効です。接続元アプリからやり直してください。</p>",
    400,
  );
  const clientLabel = (request: AuthzRequest) =>
    looksLikeUrlClientId(request.clientId) ? new URL(request.clientId).host : `${request.client.clientName} (unverified)`;
  const clientKeyOf = (request: Request) =>
    request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() || "unknown-client";
  const loginLimiter = new LoginLimiter();
  const consentPage = (request: AuthzRequest, error?: string, status = 200) =>
    renderConsentPage(render, request, resource, error, status);

  const metadata = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    revocation_endpoint: `${issuer}/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    resource_parameter_supported: true,
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...advertisedScopes],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
  const protectedMetadata = {
    resource,
    authorization_servers: [issuer],
    scopes_supported: [...advertisedScopes],
    bearer_methods_supported: ["header"],
  };

  const base: OAuthContextBase = {
    issuer, resource, metadataPath, allowedRedirects, formAction,
    metadata, protectedMetadata, loginLimiter,
    json, oauthError, render, resourceOk, resolveClient, parseAuthzRequest,
    invalidAuthzPage, clientLabel, clientKeyOf, consentPage,
  };

  if (store && tokens && !options.unavailableReason) {
    return { ...base, state: "available", store, tokens };
  }
  return {
    ...base,
    state: "unavailable",
    unavailableReason: options.unavailableReason ?? "OAuth databases are unavailable",
  };
}

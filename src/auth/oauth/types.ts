import type { OAuthClient, OAuthStore } from "../oauth-store.js";
import type { TokenStore } from "../token-store.js";
import type { LoginLimiter } from "./login-limiter.js";

export interface OAuthHandlerOptions {
  fetchImpl?: typeof fetch;
  unavailableReason?: string;
}

export interface AuthzRequest {
  client: OAuthClient;
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
  requested: string[];
}

export type PageRenderer = (title: string, body: string, status?: number) => Response;
export type StringGetter = (name: string) => string | null;

/** Context shared by discovery endpoints and both OAuth availability states. */
export interface OAuthContextBase {
  issuer: string;
  resource: string;
  metadataPath: string;
  allowedRedirects: Set<string>;
  formAction: string;
  metadata: Record<string, unknown>;
  protectedMetadata: Record<string, unknown>;
  loginLimiter: LoginLimiter;
  json(data: unknown, status?: number): Response;
  oauthError(error: string, status?: number): Response;
  render: PageRenderer;
  resourceOk(value: string | null | undefined): boolean;
  resolveClient(clientId: string): Promise<OAuthClient | undefined>;
  parseAuthzRequest(get: StringGetter): Promise<AuthzRequest | undefined>;
  invalidAuthzPage(): Response;
  clientLabel(request: AuthzRequest): string;
  clientKeyOf(request: Request): string;
  consentPage(request: AuthzRequest, error?: string, status?: number): Response;
}

/** Stateful routes can only receive this context after the availability check has narrowed it. */
export interface OAuthAvailableContext extends OAuthContextBase {
  state: "available";
  store: OAuthStore;
  tokens: TokenStore;
}

/** Discovery remains available, while routes needing a store return 503. */
export interface OAuthUnavailableContext extends OAuthContextBase {
  state: "unavailable";
  unavailableReason: string;
}

export type OAuthContext = OAuthAvailableContext | OAuthUnavailableContext;
export type OAuthRoute = (request: Request, url: URL) => Promise<Response | undefined>;

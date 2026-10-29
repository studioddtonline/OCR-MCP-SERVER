import { OAuthValidationError } from "../../oauth-store.js";
import { describeForLog } from "../../../shared/errors.js";
import type { OAuthAvailableContext } from "../types.js";

export async function handleRegister(ctx: OAuthAvailableContext, request: Request, url: URL): Promise<Response | undefined> {
  const path = url.pathname;
  if (path !== "/register" || request.method !== "POST") return undefined;

  let input: Record<string, unknown>;
  try {
    input = (await request.json()) as Record<string, unknown>;
  } catch (error) {
    console.error("[oauth/register] invalid JSON", error);
    return ctx.oauthError("invalid_client_metadata");
  }

  console.log("[oauth/register] received metadata", {
    keys: Object.keys(input),
    client_name_type: typeof input.client_name,
    client_name_length: typeof input.client_name === "string" ? input.client_name.length : undefined,
    redirect_uris_type: Array.isArray(input.redirect_uris) ? "array" : typeof input.redirect_uris,
    redirect_uris: Array.isArray(input.redirect_uris) && input.redirect_uris.every((value) => typeof value === "string")
      ? input.redirect_uris : "(invalid or non-string values)",
    grant_types: input.grant_types,
    response_types: input.response_types,
    token_endpoint_auth_method: input.token_endpoint_auth_method,
  });

  const strings = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item) => typeof item === "string");
  if (!strings(input.redirect_uris) || input.redirect_uris.length === 0) {
    console.error("[oauth/register] rejected: redirect_uris");
    return ctx.oauthError("invalid_redirect_uri");
  }
  const redirectUris = input.redirect_uris;
  const rejected = redirectUris.filter((uri) => !ctx.allowedRedirects.has(uri));
  if (rejected.length > 0) {
    console.error("[oauth/register] rejected: redirect_uri not allowed", rejected);
    return ctx.oauthError("invalid_redirect_uri");
  }
  // Accept grant_types / response_types when they are subsets of the supported values.
  if (
    input.grant_types !== undefined &&
    !(strings(input.grant_types) && input.grant_types.includes("authorization_code") &&
      input.grant_types.every((grant) => grant === "authorization_code" || grant === "refresh_token"))
  ) {
    console.error("[oauth/register] rejected: grant_types", input.grant_types);
    return ctx.oauthError("invalid_client_metadata");
  }
  if (
    input.response_types !== undefined &&
    !(strings(input.response_types) && input.response_types.includes("code") && input.response_types.every((type) => type === "code"))
  ) {
    console.error("[oauth/register] rejected: response_types", input.response_types);
    return ctx.oauthError("invalid_client_metadata");
  }
  if (input.token_endpoint_auth_method !== undefined && input.token_endpoint_auth_method !== "none") {
    console.error("[oauth/register] rejected: token_endpoint_auth_method", input.token_endpoint_auth_method);
    return ctx.oauthError("invalid_client_metadata");
  }
  const clientName = typeof input.client_name === "string" && input.client_name.trim() ? input.client_name : "MCP client";

  try {
    console.log("[oauth/register] validation passed; registering client");
    const client = ctx.store.registerClient({ clientName, redirectUris });
    console.log("[oauth/register] registration succeeded", {
      clientId: client.clientId,
      redirectUris: client.redirectUris,
    });
    return ctx.json({
      client_id: client.clientId,
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      client_id_issued_at: Math.floor(Date.now() / 1000),
    }, 201);
  } catch (error) {
    if (error instanceof OAuthValidationError) {
      console.error("[oauth/register] rejected:", error.message);
      return ctx.oauthError(error.oauthError === "invalid_request" ? "invalid_client_metadata" : error.oauthError);
    }
    console.log("[oauth/register] registration failed", describeForLog(error));
    return ctx.oauthError("temporarily_unavailable", 503);
  }
}

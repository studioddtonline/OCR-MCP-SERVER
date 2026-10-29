import { OAuthGrantError } from "../../oauth-store.js";
import { describeForLog } from "../../../shared/errors.js";
import { formBody } from "../responses.js";
import type { OAuthAvailableContext } from "../types.js";

export async function handleToken(ctx: OAuthAvailableContext, request: Request, url: URL): Promise<Response | undefined> {
  const path = url.pathname;
  if (path !== "/token" || request.method !== "POST") return undefined;
  const form = await formBody(request);
  const grantType = form.get("grant_type");
  const clientId = form.get("client_id") ?? "";
  const requestedResource = form.get("resource") ?? "";
  let clientExists: boolean;
  try {
    clientExists = Boolean(ctx.store.getClient(clientId));
  } catch (error) {
    console.log("[oauth/token] client lookup failed", error instanceof Error ? error.message : error);
    return ctx.oauthError("temporarily_unavailable", 503);
  }
  if (!clientExists) return ctx.oauthError("invalid_client", 401);
  if (!ctx.resourceOk(requestedResource)) return ctx.oauthError("invalid_target");
  try {
    let result;
    if (grantType === "authorization_code") {
      result = ctx.store.exchangeAuthorizationCode({
        code: form.get("code") ?? "",
        clientId,
        redirectUri: form.get("redirect_uri") ?? "",
        codeVerifier: form.get("code_verifier") ?? "",
      });
    } else if (grantType === "refresh_token") {
      result = ctx.store.refreshAccessToken({
        refreshToken: form.get("refresh_token") ?? "",
        clientId,
        resource: ctx.resource,
      });
    } else return ctx.oauthError("unsupported_grant_type");
    return ctx.json({
      access_token: result.accessToken,
      token_type: "Bearer",
      expires_in: Math.max(0, result.accessTokenExpiresAt - Math.floor(Date.now() / 1000)),
      refresh_token: result.refreshToken,
      scope: result.scope,
    });
  } catch (error) {
    if (error instanceof OAuthGrantError) return ctx.oauthError("invalid_grant");
    console.log("[oauth/token] token operation failed", describeForLog(error));
    return ctx.oauthError("temporarily_unavailable", 503);
  }
}

import { formBody } from "../responses.js";
import type { OAuthAvailableContext } from "../types.js";

export async function handleRevoke(ctx: OAuthAvailableContext, request: Request, url: URL): Promise<Response | undefined> {
  const path = url.pathname;
  if (path !== "/revoke" || request.method !== "POST") return undefined;
  const form = await formBody(request);
  const token = form.get("token") ?? "";
  const hint = form.get("token_type_hint");
  try {
    if (token) {
      if (hint === "refresh_token") ctx.store.revokeRefreshToken(token);
      else {
        ctx.store.revokeAccessToken(token);
        ctx.store.revokeRefreshToken(token);
      }
    }
    return ctx.json({});
  } catch (error) {
    console.log("[oauth/revoke] token revocation failed", error instanceof Error ? error.message : error);
    return ctx.oauthError("temporarily_unavailable", 503);
  }
}

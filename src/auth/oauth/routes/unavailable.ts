import type { OAuthContext } from "../types.js";

const STATEFUL_PATHS = ["/register", "/authorize", "/token", "/revoke"];

/** Keep metadata and CORS preflights available even when OAuth stores are unavailable. */
export async function handleUnavailableStatefulRoute(ctx: OAuthContext, request: Request, url: URL): Promise<Response | undefined> {
  const path = url.pathname;
  if (ctx.state !== "unavailable" || !STATEFUL_PATHS.includes(path)) return undefined;
  const reason = ctx.unavailableReason;
  console.log("[oauth] request rejected because authentication databases are unavailable:", reason);
  return ctx.oauthError("temporarily_unavailable", 503);
}

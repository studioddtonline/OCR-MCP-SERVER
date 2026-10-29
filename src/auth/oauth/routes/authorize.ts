import { OAuthValidationError } from "../../oauth-store.js";
import type { TokenStore } from "../../token-store.js";
import { OPTIONAL_SCOPES, SCOPE_READ } from "../../scopes.js";
import { describeForLog } from "../../../shared/errors.js";
import { formBody, originIsExpected } from "../responses.js";
import { LOGIN_MAX_FAILURES } from "../login-limiter.js";
import type { AuthzRequest, OAuthAvailableContext } from "../types.js";

export async function handleAuthorize(ctx: OAuthAvailableContext, request: Request, url: URL): Promise<Response | undefined> {
  const path = url.pathname;

  // Login token is required for every approval; no reusable login session/cookie is issued.
  if (path === "/authorize" && request.method === "GET") {
    try {
      const authz = await ctx.parseAuthzRequest((key) => url.searchParams.get(key));
      if (!authz) return ctx.invalidAuthzPage();
      return ctx.consentPage(authz);
    } catch (error) {
      console.log("[oauth/authorize] client lookup failed", error instanceof Error ? error.message : error);
      return ctx.oauthError("temporarily_unavailable", 503);
    }
  }

  if (path === "/authorize" && request.method === "POST") {
    if (!originIsExpected(request, ctx.issuer)) return new Response("Forbidden", { status: 403 });
    const form = await formBody(request);
    let authz: AuthzRequest | undefined;
    try {
      authz = await ctx.parseAuthzRequest((key) => form.get(key));
    } catch (error) {
      console.log("[oauth/authorize] client lookup failed", error instanceof Error ? error.message : error);
      return ctx.oauthError("temporarily_unavailable", 503);
    }
    if (!authz) return ctx.invalidAuthzPage();
    const callback = new URL(authz.redirectUri);
    if (form.get("decision") !== "approve") {
      // Denial needs no token; redirectUri has already passed the allowlist checks.
      callback.searchParams.set("error", "access_denied");
      callback.searchParams.set("state", authz.state);
      callback.searchParams.set("iss", ctx.issuer);
      return new Response(null, { status: 303, headers: { location: callback.toString(), "cache-control": "no-store" } });
    }

    const clientKey = ctx.clientKeyOf(request);
    const nowMs = Date.now();
    const failures = ctx.loginLimiter.getOrCreate(clientKey, nowMs);
    if (failures.count >= LOGIN_MAX_FAILURES) {
      return new Response("Too many login attempts", {
        status: 429,
        headers: { "retry-after": String(Math.ceil((failures.resetAt - nowMs) / 1000)), "cache-control": "no-store" },
      });
    }

    let verified: ReturnType<TokenStore["verify"]>;
    try {
      verified = ctx.tokens.verify(form.get("login_token") ?? "", "login");
    } catch (error) {
      console.log("[oauth/authorize] login-token verification failed", error instanceof Error ? error.message : error);
      return ctx.oauthError("temporarily_unavailable", 503);
    }
    if (!verified) {
      failures.count += 1;
      console.error("[oauth/authorize] login token rejected", { client: ctx.clientLabel(authz), from: clientKey });
      return ctx.consentPage(authz, "ログイン用トークンが正しくありません。", 401);
    }
    ctx.loginLimiter.reset(clientKey);

    // ocr:read is always granted; optional scopes need to be requested and checked by the user.
    const checked = new Set(form.getAll("grant_scope"));
    const granted = [SCOPE_READ, ...OPTIONAL_SCOPES.filter((scope) => authz.requested.includes(scope) && checked.has(scope))];
    const scope = granted.join(" ");
    try {
      const code = ctx.store.createAuthorizationCode({
        clientId: authz.clientId,
        redirectUri: authz.redirectUri,
        codeChallenge: authz.challenge,
        scope,
        resource: ctx.resource,
      });
      console.error("[oauth/authorize] approved", { client: ctx.clientLabel(authz), loginToken: verified.name, scope });
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", authz.state);
      callback.searchParams.set("iss", ctx.issuer);
      return new Response(null, { status: 303, headers: { location: callback.toString(), "cache-control": "no-store" } });
    } catch (error) {
      if (error instanceof OAuthValidationError) return ctx.invalidAuthzPage();
      console.log("[oauth/authorize] authorization-code persistence failed", describeForLog(error));
      return ctx.oauthError("temporarily_unavailable", 503);
    }
  }
  return undefined;
}

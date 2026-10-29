import type { OAuthContextBase } from "../types.js";

export async function handleMetadata(ctx: OAuthContextBase, request: Request, url: URL): Promise<Response | undefined> {
  const path = url.pathname;
  if (request.method === "OPTIONS" && ["/token", "/register", "/revoke"].includes(path)) {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "Content-Type, Authorization",
        "access-control-max-age": "600",
      },
    });
  }
  if (
    request.method === "GET" &&
    ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"].includes(path)
  ) return ctx.json(ctx.metadata);
  if (
    request.method === "GET" &&
    [ctx.metadataPath, "/.well-known/oauth-protected-resource"].includes(path)
  ) return ctx.json(ctx.protectedMetadata);
  return undefined;
}
